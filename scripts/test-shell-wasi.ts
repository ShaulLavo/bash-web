// The browser process service is deliberately not substituted by this harness.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzipSync } from "node:zlib";
import { shellTargetDirectory, wasiBuildEnvironment } from "./wasi-build.ts";
import { verifyCiArtifacts } from "./ci-artifacts.ts";
import { familyProgramNames, familyWasmPath } from "./family-assets.ts";
import { verifyFamilyGuest } from "./verify-family-guests.ts";
import { wasiTestArguments, wasiTestFiles, wasiTestTargets } from "./prepare-wasi-tests.ts";
import { functionNames, verifyWasiGuest } from "./verify-wasi-guests.ts";

const brotliAsync = promisify(brotliCompress);
const root = resolve(import.meta.dirname, "..");
const prebuilt = process.argv[2] === "--prebuilt" ? process.argv[3] : undefined;
assert.ok(
  process.argv.length === 2 || (prebuilt && process.argv.length === 4),
  "Use --prebuilt <artifact directory> or no arguments",
);

async function runPrebuiltBinary(
  prebuiltDir: string,
  binary: string,
  active: Set<ChildProcess>,
): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      "wasmtime",
      [
        "run",
        "-W",
        "max-memory-size=268435456",
        resolve(prebuiltDir, "wasi-tests", binary),
        "--test-threads=1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    active.add(child);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => {
      active.delete(child);
      fail(error);
    });
    child.once("close", (code, signal) => {
      active.delete(child);
      const text = Buffer.concat(chunks).toString("utf8");
      if (code === 0 && !signal) done(text);
      else fail(new Error(`WASI test ${binary} failed (${signal ?? code}):\n${text}`));
    });
  });
}

async function runPrebuiltTests(prebuiltDir: string): Promise<void> {
  const concurrency = Math.max(1, Math.min(4, availableParallelism()));
  const outputs = new Array<string | undefined>(wasiTestFiles.length);
  const active = new Set<ChildProcess>();
  let firstError: unknown;
  let aborted = false;
  let next = 0;
  const abort = (error: unknown) => {
    if (aborted) return;
    aborted = true;
    firstError = error;
    for (const child of active) child.kill("SIGTERM");
  };
  const runIndex = async (index: number) => {
    try {
      outputs[index] = await runPrebuiltBinary(prebuiltDir, wasiTestFiles[index], active);
    } catch (error) {
      abort(error);
    }
  };
  const worker = async () => {
    while (!aborted && next < wasiTestFiles.length) {
      await runIndex(next++);
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, wasiTestFiles.length) }, () => worker()),
  );
  for (const text of outputs) {
    if (text !== undefined) process.stdout.write(text);
  }
  if (firstError !== undefined) throw firstError;
}

if (prebuilt) {
  verifyCiArtifacts(root, resolve(prebuilt));
  await runPrebuiltTests(prebuilt);
} else {
  const cargoEnv = wasiBuildEnvironment(root, shellTargetDirectory(root));
  const env = {
    ...cargoEnv,
    CARGO_TARGET_WASM32_WASIP1_RUNNER:
      process.env.CARGO_TARGET_WASM32_WASIP1_RUNNER || "wasmtime run",
  };
  const jobs = process.env.CARGO_BUILD_JOBS ? [] : ["-j2"];
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
      ].concat(wasiTestArguments(target), jobs, ["--", "--test-threads=1"]),
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
      "--release",
    ].concat(jobs),
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

async function measureSize(label: string, path: string, verify = () => verifyWasiGuest(path)) {
  verify();
  const bytes = readFileSync(path);
  const [brotli, gzip] = await Promise.all([
    brotliAsync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    Promise.resolve(gzipSync(bytes, { level: 9 }).length),
  ]);
  return {
    line: `${label}: ${bytes.length} bytes raw; ${gzip} bytes gzip-9; ${brotli.length} bytes brotli-11`,
    brotli: brotli.length,
  };
}

const runtimeWasm = resolve(release, "shell-runtime.wasm");
for (const binary of ["shell-runtime", "argv-py", "printenv-py"]) {
  const path = resolve(release, `${binary}.wasm`);
  verifyWasiGuest(path, undefined, "waffle_program_support::runtime::wasi");
  const module = new WebAssembly.Module(readFileSync(path));
  const imports = WebAssembly.Module.imports(module);
  assert.ok(
    imports.some((entry) => entry.module === "shell_terminal" && entry.name === "inherited_fd"),
    `${binary} launch bindings must stay shell-owned`,
  );
  assert.ok(
    !imports.some((entry) => entry.module === "runtime_proc" && entry.name === "inherited_fd"),
    `${binary} must not query the generic program launch descriptor list`,
  );
  assert.ok(
    !Array.from(functionNames(module).keys()).some((name) => name.includes("observation::")),
    `${binary} must not contain development stack observation`,
  );
}

const sizeTasks: Promise<{ line: string; brotli: number }>[] = [
  measureSize("Shell core release WASI (standalone embedding)", wasm),
  measureSize("Shell core release WASI (browser runtime)", runtimeWasm, () =>
    verifyWasiGuest(runtimeWasm, undefined, "waffle_program_support::runtime::wasi"),
  ),
].concat(
  familyProgramNames.map((program) =>
    measureSize(`Utility add-on ${program}`, familyWasmPath(program), () =>
      verifyFamilyGuest(program),
    ),
  ),
);
const measured = await Promise.all(sizeTasks);
for (const entry of measured) console.log(entry.line);
assert.ok(measured[0].brotli <= 1_000_000, "shell core exceeds Brush's 1.0 MB brotli guardrail");
