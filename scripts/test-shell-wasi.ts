// The browser process service is deliberately not substituted by this harness.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { shellTargetDirectory, wasiBuildEnvironment } from "./wasi-build.ts";
import { buildWc } from "./build-wc.ts";
import { verifyCiArtifacts } from "./ci-artifacts.ts";
import { wasiTestArguments, wasiTestFiles, wasiTestTargets } from "./prepare-wasi-tests.ts";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";

const root = resolve(import.meta.dirname, "..");
const prebuilt = process.argv[2] === "--prebuilt" ? process.argv[3] : undefined;
assert.ok(
  process.argv.length === 2 || (prebuilt && process.argv.length === 4),
  "Use --prebuilt <artifact directory> or no arguments",
);
if (prebuilt) {
  verifyCiArtifacts(root, resolve(prebuilt));
  for (const binary of wasiTestFiles)
    execFileSync(
      "wasmtime",
      [
        "run",
        "-W",
        "max-memory-size=268435456",
        resolve(prebuilt, "wasi-tests", binary),
        "--test-threads=1",
      ],
      { stdio: "inherit" },
    );
} else {
  buildWc();
  const cargoEnv = wasiBuildEnvironment(root, shellTargetDirectory(root));
  const env = {
    ...cargoEnv,
    CARGO_TARGET_WASM32_WASIP1_RUNNER:
      process.env.CARGO_TARGET_WASM32_WASIP1_RUNNER || "wasmtime run",
  };
  for (const target of wasiTestTargets)
    execFileSync(
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "shell/Cargo.toml",
        "--target",
        "wasm32-wasip1",
      ].concat(wasiTestArguments(target), ["-j2", "--", "--test-threads=1"]),
      { cwd: root, stdio: "inherit", env },
    );
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      "shell/Cargo.toml",
      "--target",
      "wasm32-wasip1",
      "-p",
      "shell-engine",
      "-p",
      "shell-utilities",
      "--release",
      "-j2",
    ],
    { cwd: root, stdio: "inherit", env: cargoEnv },
  );
}
const release = prebuilt
  ? resolve(prebuilt)
  : resolve(shellTargetDirectory(root), "wasm32-wasip1/release");
const wasm = resolve(release, "shell-engine.wasm");
verifyWasiGuest(wasm);
const output = execFileSync(
  "wasmtime",
  ["run", wasm, "-c", 'false | true; printf \'STATUS:%s:%s\\n\' "$?" "${PIPESTATUS[*]}"'],
  { encoding: "utf8" },
);
assert.equal(output, "STATUS:0:1 0\n");
const invoke = (script: string) => {
  const result = spawnSync("wasmtime", ["run", wasm, "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
};
const separate = invoke("printf out; printf err >&2; exit 7");
assert.equal(separate.status, 7);
assert.equal(separate.stdout.toString(), "out");
assert.equal(separate.stderr.toString(), "err");
const longErrors = invoke(
  "for ((i=1;i<=20000;i++)); do printf '%s\n' \"$i\" >&2; done; printf done; exit 7",
);
assert.equal(longErrors.status, 7);
assert.equal(longErrors.stdout.toString(), "done");
assert.ok(longErrors.stderr.toString().endsWith("20000\n"));
const helpers = execFileSync(
  "wasmtime",
  ["run", "--env", "HOME=/home/fixture", wasm, "-c", "argv.py a 'b c'; printenv.py HOME MISSING"],
  { encoding: "utf8" },
);
assert.equal(helpers, "['a', 'b c']\n/home/fixture\nNone\n");
const size = (label: string, path: string) => {
  verifyWasiGuest(path);
  const bytes = readFileSync(path);
  const brotli = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const gzip = gzipSync(bytes, { level: 9 }).length;
  console.log(
    `${label}: ${bytes.length} bytes raw; ${gzip} bytes gzip-9; ${brotli.length} bytes brotli-11`,
  );
  return brotli.length;
};
const core = size("Shell core release WASI (standalone embedding)", wasm);
assert.ok(core <= 1_000_000, "shell core exceeds Brush's 1.0 MB brotli guardrail");
size("Shell core release WASI (browser runtime)", resolve(release, "shell-runtime.wasm"));
for (const name of ["cat", "grep", "head", "ls", "mkdir", "seq", "tail", "wc"])
  size(`Utility add-on ${name}`, resolve(release, `${name}.wasm`));
