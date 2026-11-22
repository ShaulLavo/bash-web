import { deleteWorkspace, openIdleWorkspace } from "waffle";

/** Shown when another tab still holds the workspace; Waffle then deletes nothing. */
export const START_FRESH_BUSY =
  "This workspace is open in another tab. Close the other tabs, then press Start fresh again.";

/** Shown when no saved workspace of that name exists to delete, so a reload would fail the same way. */
export const START_FRESH_NOTHING =
  "Start fresh found no saved workspace to delete, so nothing was changed. Reload the page to try again.";

/** The workspace Waffle opens when the page names none. */
export const DEFAULT_WORKSPACE = "waffle-workspace";

type FilesystemState = { readonly status: string; readonly error?: unknown };
type StartFreshResult = "deleted" | "missing" | "busy" | "readable";
type Selection = { readonly mode: "fast"; readonly name: string };
export type WorkspaceStorage = {
  open(selection: Selection): Promise<Awaited<ReturnType<typeof openIdleWorkspace>>>;
  remove(selection: Selection): Promise<"deleted" | "missing" | "busy">;
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

/** The VfsError codes along an error's cause chain. Errors cross the filesystem worker as VfsError. */
function vfsCodes(error: unknown): string[] {
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

const waffle: WorkspaceStorage = { open: openIdleWorkspace, remove: deleteWorkspace };

/**
 * Deletes the named fast-mode workspace, but only while it still cannot be opened, so the page
 * can open it fresh. The failed runtime is disposed first, so it holds neither store when Waffle
 * claims them. Another tab may have recovered the workspace since this page failed: a workspace
 * that now opens, or no longer exists, is kept ("readable", "missing"). "busy" means another tab
 * or handle holds it and nothing was deleted.
 */
export async function startFresh(
  dispose: (() => Promise<unknown>) | undefined,
  workspace: string,
  storage: WorkspaceStorage = waffle,
): Promise<StartFreshResult> {
  try {
    await dispose?.();
  } catch (error) {
    console.warn("Start fresh: the failed runtime did not dispose cleanly", error);
  }
  const selection = { mode: "fast", name: workspace } as const;
  let opened: Awaited<ReturnType<WorkspaceStorage["open"]>>;
  try {
    opened = await storage.open(selection);
  } catch (error) {
    if (!vfsCodes(error).includes("INVALID_VFS_FORMAT")) throw error;
    return storage.remove(selection);
  }
  if (typeof opened === "string") return opened;
  await opened.close();
  return "readable";
}
