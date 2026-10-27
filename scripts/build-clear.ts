import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildWasiShell, shellTargetDirectory } from "./wasi-build.ts";

const root = resolve(import.meta.dirname, "..");
buildWasiShell(["-p", "shell-clear", "--bin", "clear"]);
for (const directory of ["dist", "public/programs"]) {
  mkdirSync(resolve(root, directory), { recursive: true });
  copyFileSync(
    resolve(shellTargetDirectory(root), "wasm32-wasip1/release/clear.wasm"),
    resolve(root, directory, "clear.wasm"),
  );
}
