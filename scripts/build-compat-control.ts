// Build immutable integrated main with its original in-shell utilities for instrument control.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { wasiBuildEnvironment } from "./wasi-build.ts";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
const root = resolve(import.meta.dirname, "..");
const reference = process.argv[2] ?? "02df6429cc142a771ff9ad26fae3f3d250d0bc04";
const sha = execFileSync("git", ["rev-parse", "--verify", `${reference}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const source = resolve(root, ".build", `compat-control-${sha}`);
mkdirSync(source, { recursive: false });
try {
  const archive = resolve(source, "source.tar");
  writeFileSync(archive, execFileSync("git", ["archive", sha, "shell"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", source]);
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? ".build/shell");
  execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-wasip1", "--manifest-path", resolve(source, "shell/Cargo.toml"), "-p", "shell-engine", "--bin", "shell-runtime", "-j2"], { cwd: root, env: wasiBuildEnvironment(root, target), stdio: "inherit" });
  const wasm = resolve(target, "wasm32-wasip1/release/shell-runtime.wasm");
  verifyWasiGuest(wasm);
  const output = resolve(target, "compat-control");
  mkdirSync(output, { recursive: true });
  copyFileSync(wasm, resolve(output, `${sha}.wasm`));
  writeFileSync(resolve(output, `${sha}.json`), JSON.stringify({ commit: sha, artifact: `${sha}.wasm`, purpose: "unchanged-main Waffle Node instrument control; not candidate scoring" }) + "\n");
} finally { rmSync(source, { recursive: true, force: true }); }
