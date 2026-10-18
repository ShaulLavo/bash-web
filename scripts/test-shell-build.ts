import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellBuild, shellFeatures, shellTargetDirectory } from "./shell-build.ts";

test("Full stays the default and presets always disable Cargo defaults explicitly", () => {
  assert.equal(shellBuild({}), "full");
  for (const build of ["full", "lite"] as const) {
    assert.equal(shellBuild({ BASH_WEB_BUILD: build }), build);
    assert.deepEqual(shellFeatures(build), ["--no-default-features", "--features", build]);
  }
});

test("unknown and unioned presets fail before any build", () => {
  for (const build of ["", "Full", "full,lite", "full lite", "acceptance-utilities"]) {
    assert.throws(() => shellBuild({ BASH_WEB_BUILD: build }), /must be full or lite/);
  }
});

test("Lite cannot overwrite the Full target, including with a custom target root", () => {
  assert.equal(shellTargetDirectory("/fixture", "full", {}), "/fixture/.build/shell");
  assert.equal(shellTargetDirectory("/fixture", "lite", {}), "/fixture/.build/shell/lite");
  const env = { CARGO_TARGET_DIR: "/separate/target" };
  assert.equal(shellTargetDirectory("/fixture", "full", env), "/separate/target");
  assert.equal(shellTargetDirectory("/fixture", "lite", env), "/separate/target/lite");
});

test("browser packaging keeps the runtime guest at its stable name in both presets", (context) => {
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(resolve(root, ".build"), { recursive: true });
  const fixture = mkdtempSync(resolve(root, ".build/browser-preset-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(resolve(fixture, "scripts"));
  for (const script of ["build-shell-browser.mjs", "shell-build.ts"]) {
    copyFileSync(resolve(root, "scripts", script), resolve(fixture, "scripts", script));
  }
  // Only the long WASI compilation is substituted. Run the real packaging entrypoint.
  writeFileSync(
    resolve(fixture, "scripts/wasi-build.ts"),
    `
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellBuild, shellTargetDirectory } from "./shell-build.ts";
export function buildWasiShell(args: readonly string[]) {
  assert.deepEqual(args, ["-p", "shell-engine", "--bin", "shell-runtime"]);
  const build = shellBuild();
  const target = resolve(shellTargetDirectory(process.cwd(), build), "wasm32-wasip1/release");
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, "shell-runtime.wasm"), "runtime-" + build);
  writeFileSync(resolve(target, "shell-engine.wasm"), "wrong-standalone-CLI");
}
`,
  );
  for (const build of ["full", "lite"]) {
    execFileSync(process.execPath, [resolve(fixture, "scripts/build-shell-browser.mjs")], {
      cwd: fixture,
      env: { ...process.env, BASH_WEB_BUILD: build, CARGO_TARGET_DIR: "target" },
      timeout: 10000,
    });
    assert.equal(
      readFileSync(resolve(fixture, "public/programs/shell-engine.wasm"), "utf8"),
      `runtime-${build}`,
    );
  }
  assert.equal(
    readFileSync(resolve(fixture, "target/wasm32-wasip1/release/shell-runtime.wasm"), "utf8"),
    "runtime-full",
  );
  assert.equal(
    readFileSync(resolve(fixture, "target/lite/wasm32-wasip1/release/shell-runtime.wasm"), "utf8"),
    "runtime-lite",
  );
});
