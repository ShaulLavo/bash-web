import assert from "node:assert/strict";
import test from "node:test";
import { testExecutables, wasiTestTargets } from "./prepare-wasi-tests.ts";

test("CI compiles exactly the existing WASI test target selection", () => {
  assert.deepEqual(
    wasiTestTargets.map((target) => target.join(" ")),
    [
      "-p shell-parser --lib --test api --test conditional --test command_print",
      "-p shell-engine --lib --test streaming --test terminal_display --test words",
    ],
  );
});

test("only Cargo test executables are transferred, not cached directory leftovers", () => {
  const binaries = ["parser.wasm", "api.wasm", "conditional.wasm", "command_print.wasm"];
  const ignored: unknown[] = [
    { reason: "compiler-artifact", executable: null },
    { reason: "compiler-artifact", executable: "shell-runtime.wasm", profile: { test: false } },
    { reason: "build-finished", success: true },
  ];
  const messages = ignored.concat(
    binaries.map((executable) => ({
      reason: "compiler-artifact",
      executable,
      profile: { test: true },
    })),
  );
  assert.deepEqual(
    testExecutables(messages.map((message) => JSON.stringify(message)).join("\n")),
    binaries,
  );
  assert.throws(() => testExecutables(JSON.stringify(messages[0])), /four existing test targets/);
});
