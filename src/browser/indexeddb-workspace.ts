/**
 * Deletes a saved workspace from IndexedDB only. Waffle's own `deleteWorkspace` also removes an
 * OPFS workspace of the same name, but the page's unreadable-format check looked at IndexedDB
 * alone, so a healthy OPFS workspace must not go with it. Waffle has no IndexedDB-only call, so
 * this takes the two Web Locks Waffle's owners hold for a workspace (names from Waffle's
 * `fs/storage-maintenance.ts` and `fs/indexeddb.ts`) and deletes the database under them. If
 * Waffle changes those names, the e2e test "Start fresh keeps a healthy OPFS workspace" fails.
 *
 * "busy" means another tab or handle holds the workspace and nothing was deleted. "missing"
 * means no database of that name was saved by Waffle; a database that is not a Waffle workspace
 * is never touched.
 */
export async function deleteIndexedDbWorkspace(selection: {
  readonly name: string;
}): Promise<"deleted" | "missing" | "busy"> {
  const workspace = selection.name;
  if (!globalThis.indexedDB || !globalThis.navigator?.locks) return "missing";
  return underLock(`bun-wasm:filesystem:indexeddb-maintenance:${workspace}`, () =>
    underLock(`bun-wasm:filesystem:indexeddb:${workspace}`, () => removeDatabase(workspace)),
  );
}

type Removal = "deleted" | "missing" | "busy";

function underLock(lock: string, body: () => Promise<Removal>): Promise<Removal> {
  const options = { mode: "exclusive", ifAvailable: true } as const;
  return navigator.locks.request(lock, options, (held) =>
    held ? body() : Promise.resolve<Removal>("busy"),
  );
}

async function removeDatabase(workspace: string): Promise<Removal> {
  const names = (await indexedDB.databases()).map((database) => database.name);
  if (!names.includes(workspace)) return "missing";
  if (!(await savedByWaffle(workspace))) return "missing";
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(workspace);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  return "deleted";
}

/** Whether the saved database is a Waffle workspace, whichever format version wrote it. */
function savedByWaffle(workspace: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(workspace);
    // Opening a database that vanished since the listing would create it; roll that back.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () =>
      request.error?.name === "AbortError" ? resolve(false) : reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      looksLikeWorkspace(database).then(
        (found) => {
          database.close();
          resolve(found);
        },
        (error: unknown) => {
          database.close();
          reject(error);
        },
      );
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
