import assert from "node:assert/strict";
import { test } from "node:test";
import { shellTargetDirectory } from "./shell-build.ts";

test("one core build uses the caller-owned target directory", () => {
  assert.equal(shellTargetDirectory("/fixture", {}), "/fixture/.build/shell");
  assert.equal(shellTargetDirectory("/fixture", { CARGO_TARGET_DIR: "/separate/target" }), "/separate/target");
});
