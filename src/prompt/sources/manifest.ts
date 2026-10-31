import type { TurnFilesystem } from "../fs";
import type { DirectorySnapshot, ManifestSnapshot } from "../segments/types";

const decoder = new TextDecoder();

export async function readManifest(
  filesystem: TurnFilesystem,
  cwd: string,
  directory: DirectorySnapshot | undefined,
): Promise<ManifestSnapshot | undefined> {
  if (!directory?.names.has("package.json")) return undefined;
  const bytes = await filesystem.readFile(`${cwd.replace(/\/$/, "")}/package.json`);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== "object") return undefined;
    const object = value as Record<string, unknown>;
    return {
      name: typeof object.name === "string" ? object.name : undefined,
      version: typeof object.version === "string" ? object.version : undefined,
      private: object.private === true,
    };
  } catch {
    return undefined;
  }
}
