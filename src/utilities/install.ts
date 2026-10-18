// Original installer for bash-web's separately linked utility programs. Each program is
// its own WASM guest on the caller's single Waffle Runtime; nothing here creates a
// Runtime, a process service, a worker or a fetch until the shell actually spawns it.
import type { Runtime } from "waffle";
import { cooperativeGuestLauncher } from "../runtime/worker-launcher";

export type UtilityModule =
  | WebAssembly.Module
  | (() => WebAssembly.Module | Promise<WebAssembly.Module>);

export type UtilityOptions = {
  /** Bundler-emitted URL of this package's shell worker (`dist/shell-worker.js`). */
  readonly workerUrl?: string | URL;
} & (
  | {
      /** Bundler-emitted program URL, fetched and compiled on first spawn only. */
      readonly wasmUrl?: string | URL;
      readonly module?: never;
    }
  | {
      /** A caller-supplied module or lazy loader, for bundlers that inline WebAssembly. */
      readonly module: UtilityModule;
      readonly wasmUrl?: never;
    }
);

export interface UtilityInstallation {
  /** The canonical executable path the shell reaches through PATH. */
  readonly executable: string;
  /**
   * Release this program's registrations, then remove its executable entry when this
   * installation created it and it is unchanged. Call once its processes have stopped;
   * Runtime.dispose releases everything without this.
   */
  dispose(): Promise<void>;
}

export class UtilityConflictError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Cannot install utility at ${path}: ${reason}`);
    this.name = "UtilityConflictError";
  }
}

/** Internal description of one guest. Public entries fix `path` to `/bin/<name>`. */
export interface UtilityProgram {
  readonly name: string;
  readonly path: string;
  readonly defaultUrl: URL;
}

const installed = new WeakMap<Runtime, Set<string>>();
const encoder = new TextEncoder();

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left?.length === right.length && left.every((byte, index) => byte === right[index]);
}

function resolveUrl(url: string | URL): string {
  return new URL(url, globalThis.document?.baseURI ?? import.meta.url).href;
}

// Share an in-flight or successful load; a later spawn may retry after a failure.
function lazyModule(options: UtilityOptions, defaultUrl: URL): () => Promise<WebAssembly.Module> {
  let pending: Promise<WebAssembly.Module> | undefined;
  const load = async (): Promise<WebAssembly.Module> => {
    const module = options.module;
    if (module instanceof WebAssembly.Module) return module;
    if (module) return module();
    const url = resolveUrl(options.wasmUrl ?? defaultUrl);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Utility executable fetch failed: ${url} (${response.status})`);
    return WebAssembly.compile(await response.arrayBuffer());
  };
  return () => {
    if (pending) return pending;
    const attempt = load();
    pending = attempt;
    void attempt.catch(() => {
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  };
}

async function removeOwnedMarker(runtime: Runtime, path: string, marker: Uint8Array) {
  if (runtime.disposed) return;
  if (sameBytes(await runtime.filesystem.readFile(path), marker))
    await runtime.filesystem.remove(path);
  await runtime.filesystem.drain();
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

export async function installUtility(
  runtime: Runtime,
  program: UtilityProgram,
  options: UtilityOptions = {},
): Promise<UtilityInstallation> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const { name, path } = program;
  let paths = installed.get(runtime);
  if (!paths) installed.set(runtime, (paths = new Set()));
  if (paths.has(path)) throw new UtilityConflictError(path, "already installed on this Runtime");
  paths.add(path);
  const owned = paths;
  const marker = encoder.encode(`bash-web utility: ${name}\n`);
  const releases: Array<() => void> = [];
  let created = false;
  const release = () => {
    for (const unregister of releases.toReversed()) unregister();
    releases.length = 0;
  };
  try {
    // The executable entry is the caller-visible half of installation. An existing
    // entry is accepted only when it is this utility's own unchanged marker.
    const entry = await runtime.filesystem.lookup(path);
    if (entry) {
      if (entry.kind !== "file" || !sameBytes(await runtime.filesystem.readFile(path), marker))
        throw new UtilityConflictError(path, "another entry already exists");
    } else {
      await runtime.filesystem.mkdirp(parentDirectory(path));
      await runtime.filesystem.writeFile(path, marker, { exclusive: true });
      created = true;
      await runtime.filesystem.drain();
    }
    const adapter = `bash-web:utility:${name}`;
    const workerUrl = resolveUrl(
      options.workerUrl ?? new URL("../../dist/shell-worker.js", import.meta.url),
    );
    releases.push(runtime.registerAdapter(adapter, cooperativeGuestLauncher(runtime, workerUrl)));
    releases.push(
      runtime.registerProgram(path, {
        adapter,
        module: lazyModule(options, program.defaultUrl),
        cooperative: true,
      }),
    );
  } catch (error) {
    release();
    owned.delete(path);
    if (!created) throw error;
    try {
      // Consume the queued failure before an independent rollback attempt.
      await runtime.filesystem.drain().catch(() => {});
      await removeOwnedMarker(runtime, path, marker);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `Utility rollback failed: ${path}`);
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return {
    executable: path,
    dispose() {
      disposal ??= (async () => {
        release();
        try {
          if (created) await removeOwnedMarker(runtime, path, marker);
        } finally {
          owned.delete(path);
        }
      })();
      return disposal;
    },
  };
}
