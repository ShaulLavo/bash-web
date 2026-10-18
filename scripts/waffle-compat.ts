// Frozen-compatibility instrument on Waffle's Node runtime. One fresh Runtime and
// filesystem per case; the shell root and every program it starts are real guests on
// Waffle's production process, descriptor and bootstrap path. Output is raw bytes:
// the root's fds 1 and 2 and its children's inherited copies reach this owner as
// separate streams, never through a terminal text sink.
import { readFile } from "node:fs/promises";
import type { Runtime } from "waffle";
import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from "waffle/browser/worker";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import type * as Api from "./waffle-node-api.ts";

export interface WaffleCaseOptions {
  readonly modulePath: string;
  readonly tmp: string;
  readonly env: Readonly<Record<string, string>>;
  /** Directory holding the frozen oracle's argv.py/printenv.py fixture guests. */
  readonly fixtureDirectory: string;
  /** Separately built utility programs. Omitted for the unchanged-main control. */
  readonly utilityDirectory?: string;
}
export interface WaffleCaseResult {
  stdout: Buffer;
  stderr: Buffer;
  status?: number;
  crash?: string;
  outputLimit?: boolean;
}

/** The existing frozen contract: stdout and stderr together, counted before acceptance. */
export const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const nodeDirectory = new URL("../.build/node/", import.meta.url);
const utilities = ["cat", "grep", "mkdir", "seq"] as const;
const fixtures = [
  ["argv.py", "argv-py.wasm"],
  ["printenv.py", "printenv-py.wasm"],
] as const;

class OutputLimit extends Error {}

let api: Promise<typeof Api> | undefined;
function loadApi(): Promise<typeof Api> {
  // build-node-harness.ts emits this bundle from waffle-node-api.ts and pinned Waffle.
  api ??= import(new URL("api.mjs", nodeDirectory).href) as Promise<typeof Api>;
  return api;
}
const modules = new Map<string, Promise<WebAssembly.Module>>();
function compiled(path: string): Promise<WebAssembly.Module> {
  let module = modules.get(path);
  if (!module) modules.set(path, (module = readFile(path).then((bytes) => WebAssembly.compile(bytes))));
  return module;
}

async function provision(runtime: Runtime, options: WaffleCaseOptions, waffle: typeof Api) {
  // Match the standalone baseline's tree: only the working directory and the
  // read-only system helper directories exist, plus /bin for installed programs.
  for (const path of [options.tmp, "/usr/local/bin", "/usr/bin", "/bin"])
    await runtime.filesystem.mkdirp(path);
  const workerUrl = new URL("shell.mjs", nodeDirectory);
  for (const [name, file] of fixtures) {
    await waffle.installUtility(
      runtime,
      { name, path: `/usr/bin/${name}`, defaultUrl: new URL(`file:///${file}`) },
      { workerUrl, module: () => compiled(`${options.fixtureDirectory}/${file}`) },
    );
  }
  if (options.utilityDirectory === undefined) return;
  const directory = options.utilityDirectory;
  const installers = {
    cat: waffle.installCat,
    grep: waffle.installGrep,
    mkdir: waffle.installMkdir,
    seq: waffle.installSeq,
  };
  for (const name of utilities)
    await installers[name](runtime, { workerUrl, module: () => compiled(`${directory}/${name}.wasm`) });
}

export async function createWaffleRunner(options: WaffleCaseOptions) {
  installNodeWorkers();
  const waffle = await loadApi();
  const shell = await compiled(options.modulePath);
  return async (code: string): Promise<WaffleCaseResult> => {
    const runtime = waffle.createRuntime({
      filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), persistence: false },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let written = 0;
    let limited = false;
    let stopRoot = () => {};
    const append = (fd: number, bytes: Uint8Array) => {
      if (limited) return;
      if (written + bytes.length > OUTPUT_LIMIT_BYTES) {
        limited = true;
        stopRoot();
        return;
      }
      written += bytes.length;
      (fd === 2 ? stderr : stdout).push(Buffer.from(bytes));
    };
    try {
      await provision(runtime, options, waffle);
      await runtime.filesystem.drain();
      const status = await runRoot(runtime, waffle, shell, options, code, append, (stop) => {
        stopRoot = stop;
      });
      if (limited) throw new OutputLimit("compatibility output limit exceeded");
      return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status };
    } catch (error) {
      return {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        crash: String((error as Error)?.message ?? error),
        ...(error instanceof OutputLimit || limited ? { outputLimit: true } : {}),
      };
    } finally {
      // Runtime.dispose fences the broker, descendants and filesystem worker. Any
      // thread it leaves is a harness leak; stopping it keeps the next case fresh.
      await runtime.dispose();
      await stopNodeWorkers();
    }
  };
}

async function runRoot(
  runtime: Runtime,
  waffle: typeof Api,
  module: WebAssembly.Module,
  options: WaffleCaseOptions,
  code: string,
  output: (fd: number, bytes: Uint8Array) => void,
  onStop: (stop: () => void) => void,
): Promise<number> {
  const filesystem = runtime.filesystem.fork();
  const { port: _port, ...identity } = filesystem;
  const transport = waffle.createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: identity };
  const service = await runtime.processes();
  let acknowledged = false;
  let worker: Worker | undefined;
  const stop = () => void worker?.terminate();
  onStop(() => void service.kill(transport.pid, 9).catch(stop));
  await service.adoptRuntimeRoot(transport, {
    filesystem: identity,
    output,
    acknowledged: () => acknowledged,
    stop,
  });
  const supervisor = await service.ready();
  const state = waffle.workerProcessState(transport);
  const root = new Worker(new URL("root.mjs", nodeDirectory), { type: "module" });
  worker = root;
  const status = await new Promise<number>((resolve, reject) => {
    // Same ownership protocol as the page shell host: the owner claims the root's
    // typed outcome, acknowledges the worker, then reports it through rootExit.
    const settle = (outcome: { kind: "exited" | "signaled"; code: number }, ack: boolean) => {
      unobserve();
      acknowledged ||= ack;
      const status = waffle.waitStatus(waffle.claimOutcome(state.signals.outcome, outcome));
      service.rootExit(transport.pid, status).then(() => resolve(status), reject);
    };
    // A root stopped by a signal (the output bound's kill) exits through Waffle.
    const unobserve = supervisor.onChildExit((event) => {
      if (event.pid === transport.pid) {
        unobserve();
        resolve(waffle.waitStatus(event.result));
      }
    });
    root.onerror = (event) => {
      event.preventDefault();
      reject(new Error(`root worker failed: ${event.message}`));
    };
    root.onmessageerror = () => reject(new Error("root worker message decode failed"));
    root.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => {
      // After teardown the Runtime owns the fence; late worker messages are moot.
      if (runtime.disposed) return;
      if (data.type === "runtime-proc") {
        if (waffle.readOutcome(state.signals.outcome)?.kind === "signaled")
          service.rejectRuntimeMessage(data, transport.pid);
        else void service.runtimeMessage(data, transport.pid).catch(reject);
      } else if (data.type === "stdout" || data.type === "stderr") {
        output(data.type === "stderr" ? 2 : 1, data.data);
      } else if (data.type === "exit") {
        settle({ kind: "exited", code: data.code }, true);
      } else if (data.type === "default-signal") {
        settle({ kind: "signaled", code: data.signal }, false);
      } else if (data.type === "error" || data.type === "cleanup-error") {
        acknowledged ||= data.type === "error";
        reject(new Error(data.message));
      }
    };
    const request: RuntimeWorkerRequest = {
      module,
      args: ["shell-engine", "-c", code],
      // The baseline's standalone CLI entry defaulted PATH to /usr/bin:/bin; the
      // runtime entry inherits only its environment, so the instrument supplies it.
      env: { PATH: "/usr/bin:/bin", ...options.env, PWD: options.tmp },
      filesystem,
      runtimeProcess: transport,
    };
    root.postMessage(request, [filesystem.port]);
  });
  return status;
}
