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
 * them, so no other tab can recover the workspace in between. If Waffle changes the lock names,
 * the e2e test "Start fresh keeps a healthy OPFS workspace of the same name" fails.
 *
 * "busy": another tab or handle holds the workspace, nothing was deleted. "missing": no database
 * of that name was saved by Waffle (a database that is not a Waffle workspace is never touched).
 * "readable": the workspace opens now, so it was kept.
 */
export async function deleteUnreadableWorkspace(selection: {
  readonly name: string;
}): Promise<Removal> {
  const workspace = selection.name;
  if (!globalThis.indexedDB || !globalThis.navigator?.locks) return "missing";
  // A delete already waiting on an open connection would block this attempt's own open forever.
  if (queued.has(workspace)) return "busy";
  return underLock(`bun-wasm:filesystem:indexeddb-maintenance:${workspace}`, () =>
    underLock(`bun-wasm:filesystem:indexeddb:${workspace}`, () => removeUnreadable(workspace)),
  );
}

function underLock(lock: string, body: () => Promise<Removal>): Promise<Removal> {
  const options = { mode: "exclusive", ifAvailable: true } as const;
  return navigator.locks.request(lock, options, (held) =>
    held ? body() : Promise.resolve<Removal>("busy"),
  );
}

async function removeUnreadable(workspace: string): Promise<Removal> {
  const names = (await indexedDB.databases()).map((database) => database.name);
  if (!names.includes(workspace)) return "missing";
  const state = await inspect(workspace);
  if (state !== "unreadable") return state;
  return deleteDatabase(workspace);
}

/** Workspaces whose delete is queued behind a connection that is still open. */
const queued = new Set<string>();

/** Waits for the delete; a connection that stays open elsewhere in this browser reports "busy". */
function deleteDatabase(workspace: string): Promise<Removal> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(workspace);
    // The delete stays queued and completes once the other connection closes. Until then every
    // open of this database waits behind it, so another attempt must not start (see above).
    request.onblocked = () => {
      queued.add(workspace);
      resolve("busy");
    };
    request.onsuccess = () => {
      queued.delete(workspace);
      resolve("deleted");
    };
    request.onerror = () => {
      queued.delete(workspace);
      reject(request.error);
    };
  });
}

/**
 * Whether the saved database is no Waffle workspace ("missing"), one this Waffle opens
 * ("readable"), or one it rejects with INVALID_VFS_FORMAT ("unreadable"). The read uses Waffle's
 * own read-only reader, as its stored-workspace inspection does.
 */
async function inspect(workspace: string): Promise<"missing" | "readable" | "unreadable"> {
  const database = await openExisting(workspace);
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

function openExisting(workspace: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(workspace);
    // A database that vanished since the listing would be created by this open; roll that back.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () =>
      request.error?.name === "AbortError" ? resolve(undefined) : reject(request.error);
    request.onsuccess = () => resolve(request.result);
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
