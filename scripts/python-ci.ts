import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const pythonInputPaths = [
  "scripts/build-python.ts",
  "scripts/python-source.ts",
  "scripts/python-ci.ts",
  "scripts/wasi-build.ts",
  "scripts/verify-wasi-guests.ts",
  "patches/cpython-wasi-cwd.patch",
  "third-party/cpython/provenance.json",
  "third-party/cpython/LICENSE",
  "third-party/cpython/licenses.json",
  ".github/actions/wasi-sdk/action.yml",
  "node_modules/waffle/scripts/build-wasi-libc.sh",
  "node_modules/waffle/patches/wasi-libc/preopen-scan.patch",
];

export function pythonCacheKey(root: string, sdk: string, toolchain: string): string {
  const hash = createHash("sha256");
  for (const path of pythonInputPaths) {
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(resolve(root, path)))
      .update("\0");
  }
  hash
    .update(readFileSync(resolve(sdk, "VERSION")))
    .update("\0")
    .update(toolchain);
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk) throw new Error("WASI_SDK_PATH must name SDK34");
  const toolchain = [
    execFileSync("cc", ["--version"], { encoding: "utf8" }),
    execFileSync("python3", ["--version"], { encoding: "utf8" }),
    execFileSync(resolve(sdk, "bin/clang"), ["--version"], { encoding: "utf8" }),
  ].join("\n");
  const output = `key=${pythonCacheKey(root, sdk, toolchain)}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
