import type { Runtime } from "waffle";
import type { RuntimeWorkerRequest } from "waffle/browser/worker";
import { launchTerminalWorker } from "../runtime/worker-launcher";

export type UtilityOptions = {
  /** Bundler-produced module worker URL. */
  readonly workerUrl?: string | URL;
} & (
  | { readonly module: WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>); readonly wasmUrl?: never }
  | { readonly wasmUrl?: string | URL; readonly module?: never }
);
export interface UtilityInstallation {
  readonly executable: string;
  /** Release registrations only. Running processes and executable markers remain owned by the caller. */
  dispose(): void;
}
export class UtilityConflictError extends Error {
  constructor(readonly path: string) { super(`Cannot install utility: an entry already exists at ${path}`); this.name = "UtilityConflictError"; }
}
const installing = new WeakMap<Runtime, Set<string>>();
const encoder = new TextEncoder();
const equal = (a: Uint8Array | undefined, b: Uint8Array) => a?.length === b.length && a.every((byte, index) => byte === b[index]);

function loader(options: UtilityOptions, defaultUrl: URL): () => Promise<WebAssembly.Module> {
  let pending: Promise<WebAssembly.Module> | undefined;
  const load = async () => {
    if (options.module instanceof WebAssembly.Module) return options.module;
    if (options.module) return options.module();
    const response = await fetch(options.wasmUrl ?? defaultUrl);
    if (!response.ok) throw new Error(`Utility executable fetch failed (${response.status})`);
    return WebAssembly.compile(await response.arrayBuffer());
  };
  return () => {
    if (pending) return pending;
    const attempt = load();
    pending = attempt;
    void attempt.catch(() => { if (pending === attempt) pending = undefined; });
    return attempt;
  };
}
async function rollback(runtime: Runtime, path: string, marker: Uint8Array): Promise<void> {
  // Consume the original queued mutation error before attempting independent rollback.
  await runtime.filesystem.drain().catch(() => {});
  if (equal(await runtime.filesystem.readFile(path), marker)) await runtime.filesystem.remove(path);
  await runtime.filesystem.drain();
}
/** Install only the selected program. No runtime, process service, fetch or guest compilation is created here. */
export async function installUtility(runtime: Runtime, name: string, defaultUrl: URL, options: UtilityOptions): Promise<UtilityInstallation> {
  const path = `/bin/${name}`;
  let active = installing.get(runtime);
  if (!active) installing.set(runtime, active = new Set());
  if (active.has(path)) throw new Error(`Utility already installed or installing: ${path}`);
  active.add(path);
  const marker = encoder.encode(`bash-web external utility: ${name}\n`);
  const unregister: Array<() => void> = [];
  let created = false;
  try {
    const entry = await runtime.filesystem.lookup(path);
    if (entry && (entry.kind !== "file" || !equal(await runtime.filesystem.readFile(path), marker))) throw new UtilityConflictError(path);
    if (!entry) {
      await runtime.filesystem.mkdirp("/bin");
      await runtime.filesystem.writeFile(path, marker, { exclusive: true });
      created = true;
    }
    const adapter = `bash-web:utility:${name}`;
    const workerUrl = String(options.workerUrl ?? new URL("../../dist/program-worker.js", import.meta.url));
    unregister.push(runtime.registerAdapter(adapter, (context, service) => launchTerminalWorker<RuntimeWorkerRequest>(runtime, service, context, {
      workerUrl,
      request: { module: context.module, args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd }, interruptible: context.interruptible },
    })));
    unregister.push(runtime.registerProgram(path, { adapter, module: loader(options, defaultUrl), cooperative: true }));
  } catch (error) {
    for (const release of unregister.reverse()) release();
    active.delete(path);
    if (created) await rollback(runtime, path, marker).catch(cleanup => { throw new AggregateError([error, cleanup], `Utility rollback failed: ${path}`); });
    throw error;
  }
  let disposed = false;
  return {
    executable: path,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of unregister.reverse()) release();
      active.delete(path);
    },
  };
}
