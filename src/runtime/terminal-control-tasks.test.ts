import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalInput } from "waffle/browser/runtime-terminals";
import { createTerminalTasks } from "./terminal-control-tasks";
import { terminalValue } from "./terminal-producer";

test("quiesce aborts and joins owned input waits without cancelling the shared input", async () => {
  const input = createTerminalInput();
  const errors: unknown[] = [];
  const tasks = createTerminalTasks((error) => errors.push(error));
  const observation = input.observe();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finished = false;
  void tasks.run(async () => {
    entered();
    try {
      terminalValue(await observation.wait({ signal: tasks.signal }));
    } finally {
      finished = true;
    }
  });
  await started;
  await tasks.join();
  assert.equal(finished, true);
  assert.deepEqual(errors, []);
  assert.equal(
    tasks.run(async () => {
      throw new Error("late work");
    }),
    undefined,
  );
  assert.equal(input.cancelled(), false);
  assert.equal(input.push(Uint8Array.of(65)), 1, "other input consumers remain admitted");
  assert.deepEqual(await observation.wait(), { kind: "error", code: "INVALID" });
  input.close();
});
