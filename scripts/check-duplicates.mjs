import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const duplicateModes = ["exact", "rust-structural"];

export function duplicateArgs(mode, baseline, paths, update = false) {
  if (!duplicateModes.includes(mode)) throw new Error(`Unknown duplicate scan: ${mode}`);
  const common = [
    "--mode",
    "mild",
    "--min-lines",
    "5",
    "--min-tokens",
    "50",
    "--ignore",
    "**/target/**,**/fixtures/**,**/vendor/**",
    "--pattern",
    "**/*.{rs,ts,tsx,js,mjs,cjs}",
    "--workers",
    "2",
    "--no-colors",
    "--no-tips",
    "--reporters",
    "console",
    "--baseline",
    baseline,
    "--fail-on-empty",
  ];
  const detection =
    mode === "exact"
      ? ["--kind", "exact", "--format", "rust,typescript,tsx,javascript"]
      : ["--kind", "ast", "--format", "rust", "--similarity", "0.8", "--min-nodes", "20"];
  return common.concat(
    detection,
    update ? ["--update-baseline"] : ["--fail-on-new-clones", "0"],
    paths,
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--record")) throw new Error("Only --record is supported");
  for (const mode of duplicateModes) {
    console.log(`Duplicate scan: ${mode}`);
    const paths = mode === "exact" ? ["src", "scripts", "shell", "tests"] : ["shell"];
    const result = spawnSync(
      resolve(root, "node_modules/.bin/jscpd"),
      duplicateArgs(mode, `quality/duplicates-${mode}.json`, paths, args.includes("--record")),
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
