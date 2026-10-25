import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { PipeEndpoint } from "waffle/proc/pipes";
import type * as Api from "./waffle-node-api.ts";

const {
  Wasi,
  MemFS,
  ProcessABI,
  PipeController,
  ExecutableRegistry,
  ProcessSupervisor,
}: typeof Api = await import(new URL("../.build/node/api.mjs", import.meta.url).href);

const guest = await WebAssembly.compile(
  await readFile(
    resolve(
      process.env.CARGO_TARGET_DIR ?? ".build/shell",
      "wasm32-wasip1/release/shell-runtime.wasm",
    ),
  ),
);
const allRights = (1n << 29n) - 1n;
const encoder = new TextEncoder();

interface PausedShell {
  peer: PipeEndpoint;
  stdout: () => string;
  pause: number;
}

function runPaused(options: {
  writer: boolean;
  bindings: readonly number[];
  source: string;
  interactive?: boolean;
  onPause: (shell: PausedShell) => string;
}) {
  const input = new PipeController({ relay: "manual" });
  const inherited = new PipeController({ relay: "manual" });
  const fs = new MemFS();
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  const inheritedFds = [0, 1, 2]
    .concat(options.interactive ? [] : [9], options.bindings)
    .filter((fd, index, fds) => fds.indexOf(fd) === index);
  const namespaces: WebAssembly.Imports = {};
  const wasi = new Wasi({
    namespaces,
    args: options.interactive ? ["shell-runtime"] : ["shell-runtime", "-c", options.source],
    env: { PWD: "/" },
    fs,
    preopens: { "/": "/" },
    reservedFds: inheritedFds,
    stdout: (bytes) => output.push(bytes.slice()),
    stderr: (bytes) => errors.push(bytes.slice()),
    sleep() {
      throw new Error("shell used blocking Preview1 I/O");
    },
  });
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("fixture must not spawn children");
    },
  });
  try {
    const pid = supervisor.createRoot({ descriptors: wasi.descriptors });
    const signals = supervisor.get(pid);
    assert.ok(signals);
    const feed = input.retain(pid + 1, "write");
    const peer = inherited.retain(pid + 1, options.writer ? "read" : "write");
    const target = options.bindings[0];
    if (target === undefined) throw new Error("missing target binding");
    const endpoint = inherited.retain(pid, options.writer ? "write" : "read");
    wasi.descriptors.close(target);
    wasi.descriptors.openAt(target, endpoint, allRights, allRights);
    for (const alias of options.bindings.slice(1)) {
      const binding = wasi.descriptors.get(target);
      assert.ok(binding);
      wasi.descriptors.inherit(alias, binding);
    }
    const inputFd = options.interactive ? 0 : 9;
    wasi.descriptors.close(inputFd);
    wasi.descriptors.openAt(inputFd, input.retain(pid, "read"), allRights, allRights);
    if (options.interactive)
      assert.equal(feed.tryWrite([encoder.encode(options.source)]), options.source.length);
    let memory: WebAssembly.Memory | undefined;
    let pauses = 0;
    const stdout = () => Buffer.concat(output).toString();
    const abi = new ProcessABI({
      memory: () => {
        assert.ok(memory);
        return memory;
      },
      descriptors: wasi.descriptors,
      fs,
      pid,
      service: supervisor,
      signals,
      wait() {
        assert.ok(++pauses < 8, "guest did not resume after checkpoint input");
        const next = encoder.encode(options.onPause({ peer, stdout, pause: pauses }));
        assert.equal(feed.tryWrite([next]), next.length);
      },
    });
    namespaces.runtime_proc = abi.imports;
    namespaces.shell_terminal = {
      inherited_fd: (index: number) => inheritedFds[index] ?? -1,
      columns: () => 80,
      phase: () => {},
    };
    const instance = new WebAssembly.Instance(guest, wasi.imports(guest));
    const exportedMemory = instance.exports.memory;
    assert.ok(exportedMemory instanceof WebAssembly.Memory);
    memory = exportedMemory;
    assert.equal(wasi.start(instance), 0, Buffer.concat(errors).toString());
    assert.ok(pauses > 0, "peer checks must happen while the guest is still running");
  } finally {
    supervisor.dispose();
    wasi.descriptors.dispose();
    input.dispose();
    inherited.dispose();
    assert.ok(input.closed);
    assert.ok(inherited.closed);
  }
}

function assertClosed(peer: PipeEndpoint, writer: boolean) {
  const bytes = [new Uint8Array(1)];
  assert.equal(writer ? peer.tryRead(bytes) : peer.tryWrite(bytes), writer ? 0 : -64);
}

function closeCase(fd: number, writer: boolean, replace: boolean) {
  test(`pinned Waffle releases inherited ${fd} ${writer ? "writer" : "reader"} ${replace ? "replacement" : "close"} before guest exit`, () => {
    const redirect = replace ? `${fd}>/replacement` : `${fd}>&-`;
    runPaused({
      writer,
      bindings: [fd],
      source: `exec ${redirect}; read -u 9 checkpoint; :`,
      onPause({ peer }) {
        assertClosed(peer, writer);
        return "continue\n";
      },
    });
  });
}

for (const [fd, writer] of [
  [3, true],
  [3, false],
  [0, false],
  [1, true],
  [2, true],
] as const) {
  closeCase(fd, writer, false);
  closeCase(fd, writer, true);
}

for (const writer of [true, false]) {
  test(`pinned Waffle keeps inherited and shell aliases until final ${writer ? "writer" : "reader"} closes`, () => {
    runPaused({
      writer,
      bindings: [3, 1_000_000],
      source:
        "exec 7>&3; exec 3>&-; exec 1000000>&-; read -u 9 first; exec 7>&-; read -u 9 last; :",
      onPause({ peer, pause }) {
        if (pause === 2) assertClosed(peer, writer);
        else
          assert.equal(
            writer ? peer.tryRead([new Uint8Array(1)]) : peer.tryWrite([new Uint8Array(1)]),
            writer ? -6 : 1,
          );
        return "continue\n";
      },
    });
  });
}

test("interactive editor releases its old stdout between commands", () => {
  runPaused({
    writer: true,
    bindings: [1],
    interactive: true,
    source: "exec 1>/replacement\n",
    onPause({ peer }) {
      while (peer.tryRead([new Uint8Array(1024)]) > 0) {}
      assertClosed(peer, true);
      return "exit 0\n";
    },
  });
});

test("interactive diagnostics borrow the current stderr after exec", () => {
  runPaused({
    writer: true,
    bindings: [2],
    interactive: true,
    source: "exec 2>&1\n",
    onPause({ peer, stdout, pause }) {
      assertClosed(peer, true);
      if (pause === 1) return ")\n";
      assert.match(stdout(), /shell: /);
      return "exit 0\n";
    },
  });
});
