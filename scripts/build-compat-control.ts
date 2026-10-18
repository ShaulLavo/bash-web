// Build immutable integrated main, with its original in-shell utilities, as the
// unchanged-main instrument control for the Waffle Node harness. Never candidate scoring.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellTargetDirectory } from "./shell-build.ts";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { wasiBuildEnvironment, wasiTarget } from "./wasi-build.ts";

const root = resolve(import.meta.dirname, "..");
const reference = process.argv[2] ?? "02df6429cc142a771ff9ad26fae3f3d250d0bc04";
const sha = execFileSync("git", ["rev-parse", "--verify", `${reference}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
const base = shellTargetDirectory(root);
// A separate Cargo target: the control must never overwrite the candidate's guests.
const target = resolve(base, "compat-control-target");
const source = resolve(root, ".build", `compat-control-${sha}`);
mkdirSync(source, { recursive: false });
try {
  const archive = resolve(source, "source.tar");
  execFileSync("git", ["archive", "--output", archive, sha, "shell"], { cwd: root });
  execFileSync("tar", ["-xf", archive, "-C", source]);
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      resolve(source, "shell/Cargo.toml"),
      "-p",
      "shell-engine",
      "--bin",
      "shell-runtime",
      "-j2",
    ],
    { cwd: root, env: wasiBuildEnvironment(root, target), stdio: "inherit" },
  );
  const wasm = resolve(target, wasiTarget, "release", "shell-runtime.wasm");
  verifyWasiGuest(wasm);
  const output = resolve(base, "compat-control");
  mkdirSync(output, { recursive: true });
  copyFileSync(wasm, resolve(output, `${sha}.wasm`));
  writeFileSync(
    resolve(output, `${sha}.json`),
    JSON.stringify({
      commit: sha,
      artifact: `${sha}.wasm`,
      purpose: "unchanged-main Waffle Node instrument control; not candidate scoring",
    }) + "\n",
  );
} finally {
  rmSync(source, { recursive: true, force: true });
}
