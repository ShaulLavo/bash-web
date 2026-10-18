import { resolve } from "node:path";

/** One core shell target. Utility guests are separately linked binaries. */
export function shellTargetDirectory(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(root, env.CARGO_TARGET_DIR ?? ".build/shell");
}
