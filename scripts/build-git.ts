import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchGitSource } from "./patch-git-source.ts";

/** Ship the patched dependency inside the lazy JS asset, including in npm tarballs. */
export async function buildGit() {
  patchGitSource();
  await build({
    entryPoints: ["src/utilities/git-command.ts"],
    outfile: "dist/git-command.js",
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
    target: "es2024",
  });
  await writeFile(
    "dist/git-command.d.ts",
    'export { runGit } from "../src/utilities/git-command";\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildGit();
