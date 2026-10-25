import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createWaffleRunner, type WaffleCaseResult } from "./waffle-compat.ts";

export function createShellFixtureRunner({ utilities = true }: { utilities?: boolean } = {}) {
  const directory = resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release",
  );
  return createWaffleRunner({
    modulePath: resolve(directory, "shell-runtime.wasm"),
    fixtureDirectory: directory,
    ...(utilities ? { utilityDirectory: directory } : {}),
    tmp: "/tmp/spec",
    env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
  });
}

export function assertShellFixtureOutput(
  actual: WaffleCaseResult,
  expected: { status: number; stdout: string },
) {
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, expected.status);
  assert.equal(actual.stdout.toString(), expected.stdout);
}

export function assertShellControlOutput(actual: WaffleCaseResult, expected: { stdout: string }) {
  assert.equal(actual.crash, undefined);
  assert.equal(actual.outputLimit, undefined);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), expected.stdout);
}
