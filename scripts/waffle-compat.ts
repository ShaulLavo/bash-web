import { readFile } from "node:fs/promises";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import type * as Api from "./waffle-node-api.ts";

export interface WaffleCaseOptions {
  modulePath: string;
  home: string;
  tmp: string;
  env: Record<string, string>;
  /** Omit for the mandatory unchanged-main instrument control. */
  utilityDirectory?: string;
}
const nodeDirectory = new URL("../.build/node/", import.meta.url);
let api: Promise<typeof Api> | undefined;
async function loadApi(): Promise<typeof Api> {
  // The build emits this exact module from waffle-node-api.ts and the pinned dependency.
  api ??= import(new URL("api.mjs", nodeDirectory).href);
  return api;
}
export async function createWaffleRunner(options: WaffleCaseOptions) {
  installNodeWorkers();
  const api = await loadApi();
  const module = await WebAssembly.compile(await readFile(options.modulePath));
  return async (code: string) => {
    const runtime = api.createRuntime({ filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), persistence: false } });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let written = 0;
    let worker: Worker | undefined;
    const append = (fd: number, bytes: Uint8Array) => {
      written += bytes.length;
      if (written > 4 * 1024 * 1024) throw new Error("compatibility output limit exceeded");
      (fd === 2 ? errors : output).push(Buffer.from(bytes));
    };
    try {
      await provision(runtime, options, api);
      const filesystem = runtime.filesystem.fork();
      const { port: _port, ...identity } = filesystem;
      const transport = api.createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
      transport.data = { filesystem: identity };
      const service = await runtime.processes();
      let acknowledged = false;
      await service.adoptRuntimeRoot(transport, { filesystem: identity, output: append, acknowledged: () => acknowledged, stop: () => { worker?.terminate(); } });
      await service.ready();
      worker = new Worker(new URL("root.mjs", nodeDirectory), { type: "module" });
      const root = worker;
      const status = await new Promise<number>((resolve, reject) => {
        root.onerror = event => { event.preventDefault(); reject(new Error(event.message)); };
        root.onmessageerror = () => reject(new Error("worker message decode failed"));
        root.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => {
          try { handle(data); } catch (error) { reject(error); }
        };
        function handle(data: RuntimeWorkerMessage) {
          if (data.type === "runtime-proc") { void service.runtimeMessage(data, transport.pid).catch(reject); return; }
          if (data.type === "stdout" || data.type === "stderr") { append(data.type === "stderr" ? 2 : 1, data.data); return; }
          if (data.type === "exit") { acknowledged = true; resolve(data.code); }
          else if (data.type === "error" || data.type === "cleanup-error") reject(new Error(data.message));
          else if (data.type === "default-signal") resolve(128 + data.signal);
        }
        root.postMessage({ module, args: ["shell-engine", "-c", code], env: { ...options.env, PWD: options.tmp }, filesystem, runtimeProcess: transport }, [filesystem.port]);
      });
      await service.rootExit(transport.pid, status);
      return { stdout: Buffer.concat(output), stderr: Buffer.concat(errors), status };
    } finally {
      await runtime.dispose();
      await stopNodeWorkers();
    }
  };
}
async function provision(runtime: import("waffle").Runtime, options: WaffleCaseOptions, api: typeof Api) {
  for (const path of [options.home, options.tmp, "/dev", "/usr/bin"]) await runtime.filesystem.mkdirp(path);
  await runtime.filesystem.writeFile("/dev/null", new Uint8Array());
  if (!options.utilityDirectory) return;
  for (const [name, install] of [["cat", api.installCat], ["grep", api.installGrep], ["mkdir", api.installMkdir], ["seq", api.installSeq]] as const) {
    await install(runtime, { module: () => readFile(`${options.utilityDirectory}/${name}.wasm`).then(bytes => WebAssembly.compile(bytes)), workerUrl: new URL("program.mjs", nodeDirectory) });
  }
}
