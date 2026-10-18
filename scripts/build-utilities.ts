import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildWasiShell, shellTargetDirectory } from "./wasi-build.ts";
const root = resolve(import.meta.dirname, "..");
// Build each independent executable through the same patched-libc contract and verifier.
for (const command of ["cat", "grep", "mkdir", "seq"]) {
  buildWasiShell(["-p", "shell-utilities", "--bin", command]);
  for (const directory of ["dist", "public/programs"]) {
    mkdirSync(resolve(root, directory), { recursive: true });
    copyFileSync(
      resolve(shellTargetDirectory(root), `wasm32-wasip1/release/${command}.wasm`),
      resolve(root, directory, `${command}.wasm`),
    );
  }
}
