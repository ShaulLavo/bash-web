import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedBridge, control } from "../src/bridge";
import { waitForPrompt } from "../src/shell-prompt";
import { shellTerminalImports } from "../src/runtime/guest-imports";

test("prompt wait retains fast completion, including when phase is already running again", async () => {
  const bridge = new SharedBridge();
  const guest = shellTerminalImports(bridge.buffer);
  assert.equal(bridge.readPrompt(), undefined);
  guest.phase(1, 0);
  const initial = await waitForPrompt(bridge);
  assert.deepEqual(initial, { generation: 1n, status: 0 });
  guest.phase(2, 0);
  guest.phase(1, 1);
  guest.phase(2, 1);
  assert.deepEqual(await waitForPrompt(bridge, { after: initial.generation }), {
    generation: 2n,
    status: 1,
  });
  bridge.close();
});

test("prompt wait wakes for empty and cancelled input without a phase change", async () => {
  const bridge = new SharedBridge();
  const guest = shellTerminalImports(bridge.buffer);
  guest.phase(1, 0);
  const pending = waitForPrompt(bridge, { after: 1n });
  guest.phase(1, 130);
  assert.deepEqual(await pending, { generation: 2n, status: 130 });
  const empty = waitForPrompt(bridge, { after: 2n });
  guest.phase(1, 130);
  assert.deepEqual(await empty, { generation: 3n, status: 130 });
  bridge.close();
});

test("aborting a prompt wait preserves the reason and leaves the shell alone", async () => {
  const bridge = new SharedBridge();
  const controller = new AbortController();
  const reason = new Error("stop waiting");
  const pending = waitForPrompt(bridge, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(
    waitForPrompt(bridge, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(bridge.cancelled(), false);
  assert.equal(bridge.closed(), false);
  bridge.close();
});

for (const end of ["close", "exit", "failure"] as const) {
  test(`${end} rejects pending and later prompt waits`, async () => {
    const bridge = new SharedBridge();
    const pending = waitForPrompt(bridge);
    if (end === "close") bridge.close();
    else {
      Atomics.store(bridge.state, control.phase, end === "exit" ? 3 : 4);
      bridge.signal();
    }
    await assert.rejects(pending, /Shell closed/);
    await assert.rejects(waitForPrompt(bridge), /Shell closed/);
    bridge.close();
  });
}
