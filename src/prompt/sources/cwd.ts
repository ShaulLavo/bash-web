import type { TurnFilesystem } from "../fs";
import type { DirectorySnapshot } from "../segments/types";

export async function readDirectory(
  filesystem: TurnFilesystem,
  path: string,
): Promise<DirectorySnapshot | undefined> {
  const entry = await filesystem.lookup(path);
  if (!entry || entry.kind !== "dir") return undefined;
  return { path, names: new Set(entry.children.keys()) };
}
