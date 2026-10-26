import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildWasiShell, shellTargetDirectory } from "./wasi-build.ts";

const root = resolve(import.meta.dirname, "..");
buildWasiShell(["-p", "shell-utilities", "--bin", "ls"]);
for (const directory of ["dist", "public/programs"]) {
  mkdirSync(resolve(root, directory), { recursive: true });
  copyFileSync(
    resolve(shellTargetDirectory(root), "wasm32-wasip1/release/ls.wasm"),
    resolve(root, directory, "ls.wasm"),
  );
}
