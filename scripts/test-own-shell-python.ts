import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import {
  pythonCases,
  pythonEnvironment,
  pythonFiles,
  type PythonCase,
} from "../tests/helpers/python-cases.ts";

async function prepareBrowser() {
  const { build } = await import("esbuild");
  mkdirSync("dist", { recursive: true });
  cpSync("node_modules/@waffle/python/assets", "dist", { recursive: true });
  const shell = process.env.BASH_WEB_PYTHON_SHELL_WASM;
  if (shell) copyFileSync(shell, "dist/shell-runtime.wasm");
  for (const name of [
    "python.wasm",
    "python-stdlib.json",
    "shell-runtime.wasm",
    "shell-worker.js",
    "fs-worker.js",
  ]) {
    assert.ok(
      existsSync(`dist/${name}`),
      `Missing qualified browser asset dist/${name}; this runner never rebuilds guests`,
    );
  }
  await build({
    entryPoints: {
      "python-tests": "scripts/measure-python.ts",
      "program-worker": "waffle/browser/preview1-worker",
    },
    outdir: "dist",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "esnext",
  });
  assert.ok(existsSync("dist/program-worker.js"), "Missing generated dist/program-worker.js");
  writeFileSync("dist/serve.mjs", stripTypeScriptTypes(readFileSync("scripts/serve.ts", "utf8")));
  chmodSync("dist/serve.mjs", 0o644);
  writeFileSync(
    "dist/python-tests.html",
    '<!doctype html><meta charset="utf-8"><script type="module" src="/python-tests.js"></script>',
  );
  if (!existsSync("dist/index.html")) copyFileSync("dist/python-tests.html", "dist/index.html");
}

async function browser() {
  await prepareBrowser();
  const result = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "tests/python.spec.ts"].concat(
      process.argv.slice(2).filter((arg) => arg !== "--browser"),
    ),
    { stdio: "inherit" },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Real Python/Waffle browser acceptance failed");
}

function checkOracle(context: TestContext, example: PythonCase) {
  const scratch = mkdtempSync(join(tmpdir(), "bash-web-python-oracle-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "python-spec");
  mkdirSync(cwd);
  for (const [name, contents] of Object.entries(pythonFiles))
    writeFileSync(join(cwd, name), contents);
  const result = spawnSync(process.env.PYTHON_ORACLE ?? "python3", example.args, {
    cwd,
    env: { ...process.env, ...pythonEnvironment },
    input: example.stdin,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, example.status);
  assert.equal(result.stdout, example.stdout);
  assert.equal(result.stderr, example.stderr);
}

function oracle() {
  const identity = spawnSync(
    process.env.PYTHON_ORACLE ?? "python3",
    [
      "-c",
      'import json, platform, sys; print(json.dumps({"implementation": platform.python_implementation(), "version": sys.version, "executable": sys.executable}))',
    ],
    { encoding: "utf8" },
  );
  assert.equal(identity.status, 0, identity.stderr);
  assert.match(identity.stdout, /"implementation": "CPython"/);
  console.log(`Native oracle only: ${identity.stdout.trim()}`);
  for (const example of pythonCases) {
    test(`native CPython confirms browser usage case: ${example.name}`, (context) =>
      checkOracle(context, example));
  }
}

if (process.argv.includes("--prepare-browser")) await prepareBrowser();
else if (process.argv.includes("--browser")) await browser();
else oracle();
