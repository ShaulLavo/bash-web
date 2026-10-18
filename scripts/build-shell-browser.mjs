import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? ".build/shell");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    "shell/Cargo.toml",
    "-p",
    "shell-engine",
    "--bin",
    "shell-runtime",
    "-j2",
  ],
  { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, stdio: "inherit" },
);
const directory = resolve(root, "public/programs");
await mkdir(directory, { recursive: true });
// Browser sessions need the runtime-backed guest, not the stand-in shell CLI.
await copyFile(
  resolve(target, "wasm32-wasip1/release/shell-runtime.wasm"),
  resolve(directory, "shell-engine.wasm"),
);
