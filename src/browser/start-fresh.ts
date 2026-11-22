import { deleteUnreadableWorkspace, vfsCodes, type Removal } from "./indexeddb-workspace.ts";

/** What the page says when Start fresh deleted nothing, by reason. */
export const START_FRESH_MESSAGES: Record<Exclude<Removal, "deleted">, string> = {
  busy: "This workspace is open in another tab. Close the other tabs, then press Start fresh again.",
  // A reload would fail the same way, so the page stays put.
  missing:
    "Start fresh found no saved workspace to delete, so nothing was changed. Reload the page to try again.",
  readable: "This workspace opens now, so nothing was deleted. Reload the page to use it.",
};

/** The workspace Waffle opens when the page names none. */
export const DEFAULT_WORKSPACE = "waffle-workspace";

type FilesystemState = { readonly status: string; readonly error?: unknown };
type Selection = { readonly name: string };
export type WorkspaceStorage = {
  remove(selection: Selection): Promise<Removal>;
};

/**
 * Whether startup failed because Waffle cannot read the stored workspace's format
 * (INVALID_VFS_FORMAT). Every other failure (a worker script that did not load, a lost
 * IndexedDB connection, full storage, running out of memory) can pass on a retry with the same
 * workspace, so it keeps the Restart path and gets no Start fresh.
 */
export function unreadableWorkspace(error: unknown, state: FilesystemState | undefined): boolean {
  return (
    vfsCodes(error).includes("INVALID_VFS_FORMAT") ||
    vfsCodes(state?.error).includes("INVALID_VFS_FORMAT")
  );
}

const waffle: WorkspaceStorage = { remove: deleteUnreadableWorkspace };

/**
 * Deletes the named IndexedDB workspace, but only while it still cannot be opened, so the page
 * can open it fresh. The failed runtime is disposed first, so it holds no connection when the
 * workspace is claimed. The check and the delete happen under one claim, so another tab that
 * recovered the workspace keeps it ("readable"); a workspace that is gone or was never a Waffle
 * workspace is kept ("missing"). "busy" means another tab or connection holds it and nothing was
 * deleted.
 */
export async function startFresh(
  dispose: (() => Promise<unknown>) | undefined,
  workspace: string,
  storage: WorkspaceStorage = waffle,
): Promise<Removal> {
  try {
    await dispose?.();
  } catch (error) {
    console.warn("Start fresh: the failed runtime did not dispose cleanly", error);
  }
  return storage.remove({ name: workspace });
}
