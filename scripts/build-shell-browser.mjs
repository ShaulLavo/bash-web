import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { shellTargetDirectory } from "./shell-build.ts";
import { buildWasiShell } from "./wasi-build.ts";

const root = resolve(import.meta.dirname, "..");
const target = shellTargetDirectory(root);
buildWasiShell(["-p", "shell-engine", "--bin", "shell-runtime"]);
const directory = resolve(root, "public/programs");
await mkdir(directory, { recursive: true });
// Browser sessions need the runtime-backed guest, not the stand-in shell CLI.
await copyFile(
  resolve(target, "wasm32-wasip1/release/shell-runtime.wasm"),
  resolve(directory, "shell-engine.wasm"),
);
