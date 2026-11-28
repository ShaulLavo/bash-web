import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildWasiShell, shellTargetDirectory } from "../wasi-build.ts";
import { stripNames } from "./wasm-name-sections.ts";

const root = resolve(import.meta.dirname, "../..");
const target = shellTargetDirectory(root);
buildWasiShell(["-p", "shell-engine", "--bin", "shell-runtime"]);
const directory = resolve(root, "public/programs");
await mkdir(directory, { recursive: true });
// buildWasiShell verifies the runtime-backed guest using the names in the Cargo output.
const runtime = await readFile(resolve(target, "wasm32-wasip1/release/shell-runtime.wasm"));
await writeFile(resolve(directory, "shell-engine.wasm"), stripNames(runtime).bytes);
