import type { IndexedDBStorage } from "waffle/fs/indexeddb";

/** The VfsError codes along an error's cause chain. Errors cross the filesystem worker as VfsError. */
export function vfsCodes(error: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("name" in current && current.name === "VfsError" && "code" in current)
      if (typeof current.code === "string") found.push(current.code);
    current = "cause" in current ? current.cause : undefined;
  }
  return found;
}

export type Removal = "deleted" | "missing" | "busy" | "readable";

/**
 * Deletes a saved workspace from IndexedDB only, and only while it still cannot be read.
 * Waffle's own `deleteWorkspace` also removes an OPFS workspace of the same name, which the
 * page's unreadable-format check never looked at, and Waffle has no IndexedDB-only call. So this
 * takes the two Web Locks Waffle's owners hold for a workspace (names from Waffle's
 * `fs/storage-maintenance.ts` and `fs/indexeddb.ts`) and does the check and the delete under
 * them, so no other Waffle tab can recover the workspace in between. The locks stay held until
 * the browser's delete settles, as Waffle's own deletion claim does, so a delete that is queued
 * behind a still-open connection keeps every other attempt (any tab) answering "busy" instead of
 * hanging behind it. Code that writes to IndexedDB behind Waffle's back is not covered.
 *
 * "busy": another tab or handle holds the workspace, or a connection keeps the delete waiting
 * (it then finishes by itself once that connection closes). "missing": no database of that name
 * was saved by Waffle, or it was already gone (a database that is not a Waffle workspace is never
 * touched). "readable": the workspace opens now, so it was kept.
 */
export function deleteUnreadableWorkspace(selection: { readonly name: string }): Promise<Removal> {
  const workspace = selection.name;
  if (!globalThis.indexedDB || !globalThis.navigator?.locks) return Promise.resolve("missing");
  const outcome = Promise.withResolvers<Removal>();
  // The claim outlives the answer when the delete is blocked, so it settles separately.
  void claim(workspace, outcome.resolve).catch(outcome.reject);
  return outcome.promise;
}

/** The two Web Locks Waffle's IndexedDB owners hold for a workspace: maintenance, then writer. */
export function workspaceLockNames(workspace: string): [string, string] {
  return [
    `bun-wasm:filesystem:indexeddb-maintenance:${workspace}`,
    `bun-wasm:filesystem:indexeddb:${workspace}`,
  ];
}

async function claim(workspace: string, report: (result: Removal) => void): Promise<void> {
  const [maintenance, writer] = workspaceLockNames(workspace);
  const held = await underLock(maintenance, () =>
    underLock(writer, () => removeUnreadable(workspace, report)),
  );
  if (!held) report("busy");
}

/** Runs `body` while holding the lock; false when another owner has it. */
function underLock(lock: string, body: () => Promise<boolean>): Promise<boolean> {
  const options = { mode: "exclusive", ifAvailable: true } as const;
  return navigator.locks.request(lock, options, (held) => (held ? body() : Promise.resolve(false)));
}

async function removeUnreadable(
  workspace: string,
  report: (result: Removal) => void,
): Promise<boolean> {
  const names = (await indexedDB.databases()).map((database) => database.name);
  const state = names.includes(workspace) ? await inspect(workspace) : "missing";
  if (state === "unreadable") await deleteDatabase(workspace, report);
  else report(state);
  return true;
}

/** Resolves when the browser's delete settles; reports "busy" at once if a connection blocks it. */
function deleteDatabase(workspace: string, report: (result: Removal) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(workspace);
    request.onblocked = () => report("busy");
    request.onsuccess = (event) => {
      // A delete that found nothing (another request removed it first) still succeeds, from 0.
      report((event as IDBVersionChangeEvent).oldVersion === 0 ? "missing" : "deleted");
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Whether the saved database is no Waffle workspace ("missing"), one this Waffle opens
 * ("readable"), or one it rejects with INVALID_VFS_FORMAT ("unreadable"). The read uses Waffle's
 * own read-only reader, as its stored-workspace inspection does. "busy": the open stalled behind
 * another tab's queued delete.
 */
async function inspect(workspace: string): Promise<"missing" | "readable" | "unreadable" | "busy"> {
  const database = await openExisting(workspace);
  if (database === "stalled") return "busy";
  if (!database) return "missing";
  let storage: IndexedDBStorage | undefined;
  try {
    if (!(await looksLikeWorkspace(database))) return "missing";
    const { IndexedDBStorage: Storage } = await import("waffle/fs/indexeddb");
    storage = Storage.readOnlyConnection(database, () => Promise.resolve()).storage;
    await storage.load();
    return "readable";
  } catch (error) {
    if (vfsCodes(error).includes("INVALID_VFS_FORMAT")) return "unreadable";
    throw error;
  } finally {
    await storage?.close();
    database.close();
  }
}

/**
 * How long the open may wait. A delete another tab queued behind a still-open connection outlives
 * that tab's locks, and every open of the database waits behind it, so give up and say busy.
 */
const OPEN_TIMEOUT_MS = 10_000;

function openExisting(workspace: string): Promise<IDBDatabase | undefined | "stalled"> {
  return new Promise((resolve, reject) => {
    let stalled = false;
    // A synchronous failure rejects here, before any timer exists to clean up.
    const request = indexedDB.open(workspace);
    const timer = setTimeout(() => {
      stalled = true;
      resolve("stalled");
    }, OPEN_TIMEOUT_MS);
    // A database that vanished since the listing would be created by this open; roll that back.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => {
      clearTimeout(timer);
      if (stalled) return;
      if (request.error?.name === "AbortError") resolve(undefined);
      else reject(request.error);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      // The attempt was abandoned; do not keep a connection that would block the queued delete.
      if (stalled) request.result.close();
      else resolve(request.result);
    };
  });
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error);
  });
}

/**
 * The same test as Waffle's `isWorkspace` (`fs/idle-database.ts`): a Waffle format marker, or the
 * older three-store shape with Waffle's metadata keys. Anything else is not ours to delete.
 */
async function looksLikeWorkspace(database: IDBDatabase): Promise<boolean> {
  if (!database.objectStoreNames.contains("metadata")) return false;
  const metadata = database.transaction("metadata", "readonly").objectStore("metadata");
  const [format, epoch, keys] = await Promise.all([
    request<unknown>(metadata.get("format")),
    request<unknown>(metadata.get("epoch")),
    request(metadata.getAllKeys()),
  ]);
  if (typeof format === "string" && format.startsWith("waffle-indexeddb-")) return true;
  if (database.version !== 1 || database.objectStoreNames.length !== 3) return false;
  if (!["journal", "data"].every((store) => database.objectStoreNames.contains(store)))
    return false;
  const known = [0, 1, "epoch", "active", "identity", "format"];
  return (
    typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    epoch > 0 &&
    keys.some((key) => key === 0 || key === 1) &&
    keys.every((key) => known.includes(key as string | number))
  );
}
