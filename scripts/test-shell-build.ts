import assert from "node:assert/strict";
import { test } from "node:test";
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
