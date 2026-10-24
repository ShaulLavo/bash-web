import assert from "node:assert/strict";
import { test } from "node:test";
import { assertShellFixtureOutput } from "./shell-fixture-runner.ts";

const expected = { status: 7, stdout: "nul\0line\n雪\r\n" };
const actual = { status: 7, stdout: Buffer.from(expected.stdout), stderr: Buffer.from("diagnostic") };

test("fixture output assertion accepts exact status and decoded stdout", () => {
  assertShellFixtureOutput(actual, expected);
});

for (const [field, changed] of [
  ["crash", { ...actual, crash: "fixture assertion probe" }],
  ["status", { ...actual, status: 0 }],
  ["stdout", { ...actual, stdout: Buffer.from("changed") }],
] satisfies [string, typeof actual & { crash?: string }][]) {
  test(`fixture output assertion rejects changed ${field}`, () => {
    assert.throws(() => assertShellFixtureOutput(changed, expected), { name: "AssertionError" });
  });
}
