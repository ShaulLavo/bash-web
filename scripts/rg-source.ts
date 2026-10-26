import { execFileSync } from "node:child_process";

export function patchRipgrepSource(source: string, patch: string) {
  execFileSync("git", ["apply", patch], { cwd: source });
}
