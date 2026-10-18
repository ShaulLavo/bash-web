import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { wasiBuildEnvironment } from "./wasi-build.ts";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, ".build/test-guest");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    "tests/guest/Cargo.toml",
    "--bins",
    "-j2",
  ],
  { cwd: root, env: wasiBuildEnvironment(root, target), stdio: "inherit" },
);
const directory = resolve(root, "public/programs");
await mkdir(directory, { recursive: true });
for (const binary of ["test-guest", "test-spin"]) {
  verifyWasiGuest(resolve(target, `wasm32-wasip1/release/${binary}.wasm`));
  await copyFile(
    resolve(target, `wasm32-wasip1/release/${binary}.wasm`),
    resolve(directory, `${binary}.wasm`),
  );
}
