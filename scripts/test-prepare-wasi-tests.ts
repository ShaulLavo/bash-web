import assert from "node:assert/strict";
import test from "node:test";
import {
  testExecutables,
  wasiTestArguments,
  wasiTestFiles,
  wasiTestTargets,
} from "./prepare-wasi-tests.ts";

test("CI compiles every current WASI target exactly once", () => {
  assert.deepEqual(
    wasiTestTargets.map((target) => wasiTestArguments(target).join(" ")),
    [
      "-p shell-parser --lib --test api --test conditional --test command_print",
      "-p shell-engine --lib --test streaming --test terminal_display --test words --test capabilities",
      "-p shell-compat-fixtures --test streaming",
    ],
  );
  assert.equal(wasiTestFiles.length, 10);
  assert.equal(new Set(wasiTestFiles).size, 10);
});

for (const target of wasiTestTargets) {
  test(`${target.package} transfers only the exact Cargo test artifacts`, () => {
    const messages = target.names.map((name) => ({
      reason: "compiler-artifact",
      executable: `${name}-hash.wasm`,
      target: { name },
      profile: { test: true },
    }));
    const ignored: unknown[] = [
      { reason: "compiler-artifact", executable: null },
      { reason: "compiler-artifact", executable: "shell-runtime.wasm", profile: { test: false } },
      { reason: "build-finished", success: true },
    ];
    const encode = (values: readonly unknown[]) =>
      values.map((value) => JSON.stringify(value)).join("\n");
    assert.deepEqual(
      testExecutables(encode(ignored.concat(messages)), target.names),
      messages.map((message) => message.executable),
    );
    assert.throws(
      () => testExecutables(encode(messages.slice(1)), target.names),
      /WASI test selection/,
    );
    assert.throws(
      () => testExecutables(encode(messages.concat([messages[0]])), target.names),
      /Duplicate/,
    );
    assert.throws(() => testExecutables(encode(messages), ["wrong-target"]), /WASI test selection/);
  });
}
