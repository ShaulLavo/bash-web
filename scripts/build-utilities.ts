import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildWc } from "./build-wc.ts";
import { buildWasiShell, shellTargetDirectory } from "./wasi-build.ts";
import { utilityNames } from "./utility-artifacts.ts";
const root = resolve(import.meta.dirname, "..");
buildWc();
buildWasiShell(["-p", "shell-utilities"]);
buildWasiShell(["-p", "shell-sed", "--bin", "sed"]);
buildWasiShell(["-p", "shell-xargs", "--bin", "xargs"]);
for (const command of utilityNames) {
  for (const directory of ["dist", "public/programs"]) {
    mkdirSync(resolve(root, directory), { recursive: true });
    copyFileSync(
      resolve(shellTargetDirectory(root), `wasm32-wasip1/release/${command}.wasm`),
      resolve(root, directory, `${command}.wasm`),
    );
  }
}
