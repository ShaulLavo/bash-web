import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { shellTargetDirectory, wasiBuildEnvironment, wasiTarget } from "./wasi-build.ts";

const root = resolve(import.meta.dirname, "..");

export function buildWc() {
  if (process.env.BASH_WEB_UTILITY_ARTIFACTS) return;
  const target = shellTargetDirectory(root);
  const env = wasiBuildEnvironment(root, target);
  const flags = env.CARGO_ENCODED_RUSTFLAGS;
  if (!flags) throw new Error("The WASI build must supply encoded Rust flags");
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      "shell/Cargo.toml",
      "-j2",
      "-p",
      "shell-wc",
      "--bin",
      "wc",
    ],
    {
      cwd: root,
      env: {
        ...env,
        CARGO_ENCODED_RUSTFLAGS: `${flags}\x1f-C\x1ftarget-feature=-simd128`,
      },
      stdio: "inherit",
    },
  );
  verifyWasiGuest(resolve(target, wasiTarget, "release/wc.wasm"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWc();
