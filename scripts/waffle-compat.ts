import { readFile } from "node:fs/promises";
import type { Runtime } from "waffle";
import { familyWasmPath } from "./family-assets.ts";
import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from "waffle/browser/worker";
import type { ProgramPackage } from "waffle/programs";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import type * as Api from "./waffle-node-api.ts";

export interface WaffleCaseOptions {
  readonly modulePath: string;
  readonly tmp: string;
  readonly env: Readonly<Record<string, string>>;
  /** Directory holding the frozen oracle's argv.py/printenv.py fixture guests. */
  readonly fixtureDirectory: string;
  /** Optional archived utility directory; published package assets are used by default. */
  readonly utilityDirectory?: string;
  /** Explicit core-only selection; does not change where published assets come from. */
  readonly installPrograms?: boolean;
  /** Explicit caller program set; undefined retains every published base program. */
  readonly programs?: readonly string[];
}
export interface WaffleCaseResult {
  stdout: Buffer;
  stderr: Buffer;
  status?: number;
  crash?: string;
  outputLimit?: boolean;
}

const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const nodeDirectory = new URL("../.build/node/", import.meta.url);
const fixtures = [
  ["argv.py", "argv-py.wasm"],
  ["printenv.py", "printenv-py.wasm"],
] as const;

class OutputLimit extends Error {}

let api: Promise<typeof Api> | undefined;
function loadApi(): Promise<typeof Api> {
  api ??= import(new URL("api.mjs", nodeDirectory).href) as Promise<typeof Api>;
  return api;
}
const modules = new Map<string, Promise<WebAssembly.Module>>();
function compiled(path: string): Promise<WebAssembly.Module> {
  let module = modules.get(path);
  if (!module)
    modules.set(path, (module = readFile(path).then((bytes) => WebAssembly.compile(bytes))));
  return module;
}

export function selectBasePackages(
  packages: readonly ProgramPackage[],
  names?: readonly string[],
): ProgramPackage[] {
  if (!names) return packages.slice();
  const selected = new Set(names);
  return packages.map((family) => ({
    ...family,
    programs: family.programs.filter((program) =>
      selected.has(program.path.slice(program.path.lastIndexOf("/") + 1)),
    ),
  }));
}

function localBasePackages(
  directory: string | undefined,
  waffle: typeof Api,
  names?: readonly string[],
): ProgramPackage[] {
  return selectBasePackages(waffle.basePackages, names).map((family) => ({
    ...family,
    programs: family.programs.map((program) => {
      const name = program.path.slice(program.path.lastIndexOf("/") + 1);
      const path = directory ? `${directory}/${name}.wasm` : familyWasmPath(name);
      return {
        path: program.path,
        aliases: program.aliases,
        source: async () => new Uint8Array(await readFile(path)),
      };
    }),
  }));
}

async function provision(runtime: Runtime, options: WaffleCaseOptions, waffle: typeof Api) {
  // Match the standalone baseline's tree: the working directory and the system
  // helper directories, plus /bin for installed programs. Its in-memory filesystem
  // created files without a parent, so `>/dev/null` made a plain file; an empty
  // /dev directory reproduces exactly that on Waffle's real filesystem.
  for (const path of [options.tmp, "/usr/local/bin", "/usr/bin", "/bin", "/dev"])
    await runtime.filesystem.mkdirp(path);
  const adapter = "bash-web-compat:fixture";
  const workerUrl = new URL("child.mjs", nodeDirectory).href;
  runtime.registerAdapter(adapter, (context, service) => {
    const { argv, cwd, env } = context.request;
    const request = { module: context.module, args: argv, env: { ...env, PWD: cwd } };
    return waffle.launchTerminalWorker<RuntimeWorkerRequest>(runtime, service, context, {
      workerUrl,
      request: { ...request, interruptible: context.interruptible },
    });
  });
  for (const [name, file] of fixtures) {
    const path = `/usr/bin/${name}`;
    await runtime.filesystem.writeFile(path, new Uint8Array());
    await runtime.filesystem.drain();
    runtime.registerProgram(path, {
      adapter,
      module: () => compiled(`${options.fixtureDirectory}/${file}`),
      cooperative: true,
    });
  }
  if (options.installPrograms === false) return;
  const packages = localBasePackages(options.utilityDirectory, waffle, options.programs);
  const launcher = waffle.genericProgramLauncher(new URL("preview1.mjs", nodeDirectory));
  await waffle.installPrograms(runtime, packages, { launcher });
}

export async function createWaffleRunner(options: WaffleCaseOptions) {
  installNodeWorkers();
  const waffle = await loadApi();
  const shell = await compiled(options.modulePath);
  return async (code: string): Promise<WaffleCaseResult> => {
    const runtime = waffle.createRuntime({
      filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
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
      await runtime.dispose();
      await stopNodeWorkers();
    }
  };
}

export async function runRoot(
  runtime: Runtime,
  waffle: typeof Api,
  module: WebAssembly.Module,
  options: WaffleCaseOptions,
  code: string,
  output: (fd: number, bytes: Uint8Array) => void,
  onStop: (stop: () => void) => void,
  // Keep the frozen Bash oracle's invocation name unless a startup test supplies argv.
  args: string[] = ["bash", "-c", code],
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
  const controller = {
    filesystem: identity,
    output,
    acknowledged: () => acknowledged,
    canConfirmExit: () => acknowledged,
    stop,
  };
  await service.adoptRuntimeRoot(transport, controller);
  const supervisor = await service.ready();
  const state = waffle.workerProcessState(transport);
  const root = new Worker(new URL("root.mjs", nodeDirectory), { type: "module" });
  worker = root;
  const status = await new Promise<number>((resolve, reject) => {
    const settle = (outcome: { kind: "exited" | "signaled"; code: number }, ack: boolean) => {
      unobserve();
      acknowledged ||= ack;
      const status = waffle.waitStatus(waffle.claimOutcome(state.signals.outcome, outcome));
      service.rootExit(transport.pid, status).then(() => resolve(status), reject);
    };
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
      args,
      // The baseline's standalone CLI entry defaulted PATH to /usr/bin:/bin; the
      // runtime entry inherits only its environment, so the instrument supplies it.
      env: { PATH: "/usr/bin:/bin", ...options.env, PWD: options.tmp },
      filesystem,
      runtimeProcess: transport,
    };
    root.postMessage(request, [filesystem.port]);
  });
  // The oracle reads its pipes until every writer closes, so background jobs that
  // outlive the root still write. Join them; the pool's case timeout bounds this.
  const live = () =>
    waffle
      .workerProcessSlots(transport)
      .some(
        (slot) => !waffle.readOutcome(waffle.workerProcessState(transport, slot).signals.outcome),
      );
  while (live() && !runtime.disposed) await new Promise((resolve) => setTimeout(resolve, 2));
  return status;
}
