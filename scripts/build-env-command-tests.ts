import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { wasiBuildConfiguration } from "./wasi-build.ts";

const root = resolve(import.meta.dirname, "..");
const config = wasiBuildConfiguration(root);
const release = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
mkdirSync(release, { recursive: true });
execFileSync(
  resolve(config.sdk, "bin/clang"),
  [
    "tests/helpers/env-probe.c",
    "-O2",
    "-Wl,--max-memory=268435456",
    "-o",
    resolve(release, "env-probe.wasm"),
  ],
  { cwd: root, stdio: "inherit" },
);
