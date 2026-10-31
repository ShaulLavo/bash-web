// Runs the interactive WASI shell guest on Waffle's ProcessABI with builtins only.
// Each time the guest would block for input, `next` decides what to feed it.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export const api: typeof import("./waffle-node-api.ts") = await import(
  new URL("../.build/node/api.mjs", import.meta.url).href
);
const guest = await WebAssembly.compile(
  await readFile(
    resolve(
      process.env.CARGO_TARGET_DIR ?? ".build/shell",
      "wasm32-wasip1/release/shell-runtime.wasm",
    ),
  ),
);

interface InteractiveGuest {
  memory(): WebAssembly.Memory;
  /** Sends a signal to the shell's own process. */
  kill(signal: number): void;
  /** Bytes written to the terminal so far, by the guest or `inject`. */
  written(): number;
  /** Writes to the terminal as another process would. */
  inject(bytes: Uint8Array): void;
}
export interface InteractiveRun {
  args: readonly string[];
  /** The `shell_terminal` namespace for this run. */
  terminal(guest: InteractiveGuest): WebAssembly.ModuleImports;
  /** Called when the guest waits: bytes to feed, `null` to end input, `undefined` for nothing. */
  next(output: string): Uint8Array | null | undefined;
  onWait?(milliseconds: number): void;
}

export function runInteractive({ args, terminal, next, onWait }: InteractiveRun) {
  const input = new api.PipeController({ relay: "manual" });
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  let written = 0;
  const write = (bytes: Uint8Array) => {
    output.push(bytes.slice());
    written += bytes.length;
  };
  const namespaces: WebAssembly.Imports = {};
  const fs = new api.MemFS();
  const wasi = new api.Wasi({
    namespaces,
    args: Array.from(args),
    env: { PWD: "/" },
    fs,
    preopens: { "/": "/" },
    reservedFds: [0, 1, 2],
    stdout: write,
    stderr: (bytes) => errors.push(bytes.slice()),
    sleep() {
      throw new Error("editor must use runtime input");
    },
  });
  const supervisor = new api.ProcessSupervisor({
    registry: new api.ExecutableRegistry(),
    launch() {
      throw new Error("test uses builtins only");
    },
  });
  let result: { status: number; output: string; errors: string };
  try {
    const pid = supervisor.createRoot({ descriptors: wasi.descriptors });
    const feed = input.retain(pid + 1, "write");
    wasi.descriptors.close(0);
    wasi.descriptors.openAt(0, input.retain(pid, "read"), (1n << 29n) - 1n, 0n);
    let memory: WebAssembly.Memory | undefined;
    const signals = supervisor.get(pid);
    if (!signals) throw new Error("root has no signal state");
    const handle: InteractiveGuest = {
      memory() {
        if (!memory) throw new Error("guest memory is not ready");
        return memory;
      },
      kill: (signal) => supervisor.kill(pid, signal),
      written: () => written,
      inject: write,
    };
    const abi = new api.ProcessABI({
      memory: handle.memory,
      descriptors: wasi.descriptors,
      fs,
      pid,
      service: supervisor,
      signals,
      wait(milliseconds) {
        onWait?.(milliseconds);
        const bytes = next(Buffer.concat(output).toString());
        if (bytes === null) return feed.close();
        if (bytes && feed.tryWrite([bytes]) !== bytes.length)
          throw new Error("test input did not fit the pipe");
      },
    });
    namespaces.runtime_proc = abi.imports;
    namespaces.shell_terminal = terminal(handle);
    const instance = new WebAssembly.Instance(guest, wasi.imports(guest));
    if (!(instance.exports.memory instanceof WebAssembly.Memory))
      throw new Error("guest exports no memory");
    memory = instance.exports.memory;
    const status = wasi.start(instance);
    result = {
      status,
      output: Buffer.concat(output).toString(),
      errors: Buffer.concat(errors).toString(),
    };
  } finally {
    supervisor.dispose();
    wasi.descriptors.dispose();
    input.dispose();
  }
  return { ...result, inputClosed: input.closed };
}
