import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wasiBuildEnvironment } from "../../../scripts/wasi-build.ts";
import { verifyWasiGuest } from "../../../scripts/verify-wasi-guests.ts";

const root = resolve(import.meta.dirname, "../../..");
const target = resolve(root, ".build/wasi-process-target");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--offline",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    "shell/Cargo.toml",
    "-p",
    "shell-wasi-process",
    "--example",
    "process_fixture",
    "-j2",
  ],
  {
    cwd: root,
    env: wasiBuildEnvironment(root, target),
    stdio: "inherit",
  },
);
verifyWasiGuest(resolve(target, "wasm32-wasip1/release/examples/process_fixture.wasm"));

const fixture = resolve(target, "wasm32-wasip1/release/examples/process_fixture.wasm");
const module = new WebAssembly.Module(readFileSync(fixture));
console.log(
  JSON.stringify({
    exports: WebAssembly.Module.exports(module),
    imports: WebAssembly.Module.imports(module),
  }),
);
