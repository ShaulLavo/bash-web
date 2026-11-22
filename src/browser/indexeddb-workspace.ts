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

/** Whether the database carries a Waffle format marker, whichever format version wrote it. */
function savedByWaffle(workspace: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(workspace);
    // Opening a database that vanished since the listing would create it; roll that back.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () =>
      request.error?.name === "AbortError" ? resolve(false) : reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      readFormat(database).then(
        (format) => {
          database.close();
          resolve(typeof format === "string" && format.startsWith("waffle-indexeddb-"));
        },
        (error: unknown) => {
          database.close();
          reject(error);
        },
      );
    };
  });
}

function readFormat(database: IDBDatabase): Promise<unknown> {
  if (!database.objectStoreNames.contains("metadata")) return Promise.resolve(undefined);
  const request = database
    .transaction("metadata", "readonly")
    .objectStore("metadata")
    .get("format");
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
