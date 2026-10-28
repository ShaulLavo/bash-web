// Original installer for bash-web's separately linked utility programs. Each program is
// its own WASM guest on the caller's single Waffle Runtime; nothing here creates a
// Runtime, a process service, a worker or a fetch until the shell actually spawns it.
import type { ProgramDefinition, Runtime } from "waffle";
import { guestLauncher } from "../runtime/worker-launcher";

type UtilityModule = WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>);

type UtilitySource = Uint8Array | (() => Uint8Array | Promise<Uint8Array>);

export type WasiUtilityOptions = {
  readonly workerUrl?: string | URL;
} & (
  | { readonly wasmUrl?: string | URL; readonly source?: never }
  | { readonly source: UtilitySource; readonly wasmUrl?: never }
);

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
   * Release this program's registrations, then remove its executable entries when this
   * installation created them and they are unchanged. Call once its processes have stopped;
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
  readonly aliases?: readonly string[];
  readonly defaultUrl: URL;
  readonly execution?: "cooperative" | "wasi";
  readonly argv0?: string;
  readonly exactEnvironment?: boolean;
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
function cachedLoad<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
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

async function fetchSource(url: string | URL): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = resolveUrl(url);
  const response = await fetch(resolved);
  if (!response.ok)
    throw new Error(`Utility executable fetch failed: ${resolved} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function utilityDefinition(
  adapter: string,
  program: UtilityProgram,
  options: UtilityOptions | WasiUtilityOptions,
): ProgramDefinition {
  if (program.execution === "wasi") {
    if ("module" in options) throw new TypeError("Ordinary WASI utilities require source bytes");
    return wasiDefinition(adapter, program.defaultUrl, options);
  }
  if ("source" in options) throw new TypeError("Cooperative utilities require compiled modules");
  return cooperativeDefinition(adapter, program.defaultUrl, options);
}

function wasiDefinition(
  adapter: string,
  defaultUrl: URL,
  options: WasiUtilityOptions,
): ProgramDefinition {
  const source = options.source;
  return {
    adapter,
    source: cachedLoad(async () => {
      if (source instanceof Uint8Array) return source;
      if (source) return source();
      return fetchSource(options.wasmUrl ?? defaultUrl);
    }),
  };
}

function cooperativeDefinition(
  adapter: string,
  defaultUrl: URL,
  options: UtilityOptions,
): ProgramDefinition {
  const module = options.module;
  return {
    adapter,
    cooperative: true,
    module: cachedLoad(async () => {
      if (module instanceof WebAssembly.Module) return module;
      if (module) return module();
      return WebAssembly.compile(await fetchSource(options.wasmUrl ?? defaultUrl));
    }),
  };
}

async function removeOwnedMarker(runtime: Runtime, path: string, marker: Uint8Array) {
  if (runtime.disposed) return;
  if ((await runtime.filesystem.lookup(path))?.kind !== "file") return;
  if (sameBytes(await runtime.filesystem.readFile(path), marker))
    await runtime.filesystem.remove(path);
  await runtime.filesystem.drain();
}

async function rollbackUtility(
  runtime: Runtime,
  paths: readonly string[],
  marker: Uint8Array,
  created: readonly string[],
  release: () => void,
  error: unknown,
): Promise<never> {
  const errors = [error];
  try {
    release();
  } catch (cleanup) {
    errors.push(cleanup);
  }
  if (created.length) {
    await runtime.filesystem.drain().catch((cleanup: unknown) => errors.push(cleanup));
    for (const path of created.toReversed())
      await removeOwnedMarker(runtime, path, marker).catch((cleanup: unknown) =>
        errors.push(cleanup),
      );
  }
  if (errors.length > 1) throw new AggregateError(errors, `Utility rollback failed: ${paths[0]}`);
  throw error;
}

async function disposeUtility(
  runtime: Runtime,
  paths: readonly string[],
  marker: Uint8Array,
  created: readonly string[],
  release: () => void,
  owned: Set<string>,
): Promise<void> {
  try {
    release();
    const results = await Promise.allSettled(
      created.map((path) => removeOwnedMarker(runtime, path, marker)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, `Utility disposal failed: ${paths[0]}`);
  } finally {
    releasePaths(owned, paths);
  }
}

function releasePaths(owned: Set<string>, paths: readonly string[]): void {
  for (const path of paths) owned.delete(path);
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

async function provisionMarker(
  runtime: Runtime,
  path: string,
  marker: Uint8Array,
  created: string[],
): Promise<void> {
  // Existing matching markers may be registered, but never become ours to remove.
  const entry = await runtime.filesystem.lookup(path);
  if (entry) {
    if (entry.kind !== "file" || !sameBytes(await runtime.filesystem.readFile(path), marker))
      throw new UtilityConflictError(path, "another entry already exists");
    return;
  }
  await runtime.filesystem.mkdirp(parentDirectory(path));
  await runtime.filesystem.writeFile(path, marker, { exclusive: true });
  created.push(path);
  await runtime.filesystem.drain();
}

export function installUtility(
  runtime: Runtime,
  program: UtilityProgram & { readonly execution: "wasi" },
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation>;
export function installUtility(
  runtime: Runtime,
  program: UtilityProgram & { readonly execution?: "cooperative" },
  options?: UtilityOptions,
): Promise<UtilityInstallation>;
export async function installUtility(
  runtime: Runtime,
  program: UtilityProgram,
  options: UtilityOptions | WasiUtilityOptions = {},
): Promise<UtilityInstallation> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const { name, path } = program;
  const paths = [path].concat(program.aliases ?? []);
  let reservations = installed.get(runtime);
  if (!reservations) installed.set(runtime, (reservations = new Set()));
  const owned = reservations;
  for (const candidate of paths) {
    if (owned.has(candidate))
      throw new UtilityConflictError(candidate, "already installed on this Runtime");
  }
  for (const candidate of paths) owned.add(candidate);
  const marker = encoder.encode(`bash-web utility: ${name}\n`);
  const releases: Array<() => void> = [];
  const created: string[] = [];
  const release = () => {
    for (const unregister of releases.toReversed()) unregister();
    releases.length = 0;
  };
  try {
    for (const candidate of paths) await provisionMarker(runtime, candidate, marker, created);
    const adapter = `bash-web:utility:${name}`;
    const workerUrl = resolveUrl(
      options.workerUrl ?? new URL("../../dist/shell-worker.js", import.meta.url),
    );
    releases.push(
      runtime.registerAdapter(
        adapter,
        guestLauncher(runtime, workerUrl, program.argv0, program.exactEnvironment),
      ),
    );
    const definition = utilityDefinition(adapter, program, options);
    for (const candidate of paths) releases.push(runtime.registerProgram(candidate, definition));
  } catch (error) {
    try {
      return await rollbackUtility(runtime, paths, marker, created, release, error);
    } finally {
      releasePaths(owned, paths);
    }
  }
  let disposal: Promise<void> | undefined;
  return {
    executable: path,
    dispose() {
      disposal ??= disposeUtility(runtime, paths, marker, created, release, owned);
      return disposal;
    },
  };
}
