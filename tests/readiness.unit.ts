import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHELL_READY_TIMEOUT_MS,
  storageBudget,
  waitForStartup,
  waitForShellReady,
  type ReadinessObservation,
  type ReadinessPoll,
} from "./helpers/readiness-policy.ts";
import { STORAGE_READY_TIMEOUT_MS } from "../src/runtime/storage.ts";

function clock(storageReadyAt: number, shellReadyAt: number) {
  let now = 0;
  const polls: { started: number; timeout: number; message: string }[] = [];
  const startup = {
    stages: { "indexeddb-open-requested": 1234 },
    pending: ["indexeddb-open-requested"],
    last: { stage: "indexeddb-open-requested", timestamp: 1234 },
  };
  const read = async (): Promise<ReadinessObservation> => ({
    snapshot: {
      state: now >= shellReadyAt ? "ready" : "starting",
      storage: { status: now >= storageReadyAt ? "ready" : "opening" },
      startup,
    },
  });
  const wait: ReadinessPoll = async (sample, options) => {
    polls.push({ started: now, ...options });
    const deadline = now + options.timeout;
    while (true) {
      if (await sample()) return;
      if (now >= deadline) throw new Error("Fake polling deadline expired");
      now = Math.min(deadline, now + 100);
    }
  };
  return { read, wait, polls, now: () => now };
}

test("8.4-second storage opening leaves a fresh five-second shell readiness clock", async () => {
  const fixture = clock(8400, 13300);
  let storageSettledAt = -1;
  await waitForStartup(fixture.read, fixture.wait, () => {
    storageSettledAt = fixture.now();
  });
  assert.equal(storageSettledAt, 8400);
  assert.deepEqual(
    fixture.polls.map(({ started, timeout }) => ({ started, timeout })),
    [
      { started: 0, timeout: STORAGE_READY_TIMEOUT_MS },
      { started: 8400, timeout: SHELL_READY_TIMEOUT_MS },
    ],
  );
  assert.equal(fixture.now(), 13300);
});

test("shell still fails after exactly five seconds once storage is ready", async () => {
  const fixture = clock(8400, 13500);
  await assert.rejects(waitForStartup(fixture.read, fixture.wait), (error: Error) => {
    assert.match(error.message, /shell phase \(5000 ms\)/);
    assert.match(error.message, /"stages":\{"indexeddb-open-requested":1234\}/);
    assert.match(error.message, /"pending":\["indexeddb-open-requested"\]/);
    assert.match(error.message, /"last":\{"stage":"indexeddb-open-requested","timestamp":1234\}/);
    return true;
  });
  assert.equal(fixture.now(), 13400);
});

test("hung storage fails in the storage phase under the application's own bound", async () => {
  const fixture = clock(Infinity, Infinity);
  let settled = false;
  await assert.rejects(
    waitForStartup(fixture.read, fixture.wait, () => {
      settled = true;
    }),
    /storage phase \(60000 ms\).*indexeddb-open-requested/,
  );
  assert.equal(settled, true);
  assert.equal(fixture.now(), STORAGE_READY_TIMEOUT_MS);
  assert.equal(fixture.polls.length, 1);
});

test("ready storage does not add another storage delay to shell readiness", async () => {
  const fixture = clock(0, 5100);
  await assert.rejects(waitForStartup(fixture.read, fixture.wait), /shell phase \(5000 ms\)/);
  assert.equal(fixture.now(), SHELL_READY_TIMEOUT_MS);
});

test("missing snapshots stay in the storage phase and preserve the visible failure", async () => {
  const wait: ReadinessPoll = async (sample) => {
    assert.equal(await sample(), false);
    throw new Error("Bounded poll expired");
  };
  await assert.rejects(
    waitForStartup(async () => ({ failure: "terminal could not open" }), wait),
    /storage phase.*terminal could not open/,
  );
});

test("command readiness never turns into a storage startup or extends its shell bound", async () => {
  const fixture = clock(Infinity, 5100);
  await assert.rejects(waitForShellReady(fixture.read, fixture.wait), /shell phase \(5000 ms\)/);
  assert.equal(fixture.now(), SHELL_READY_TIMEOUT_MS);
  assert.equal(fixture.polls.length, 1);
  assert.equal(fixture.polls[0].timeout, SHELL_READY_TIMEOUT_MS);
});

test("enclosing test gets the storage allowance once, then only actual elapsed storage time", async () => {
  const fixture = clock(8400, 9000);
  const timeouts: number[] = [];
  await waitForStartup(
    fixture.read,
    fixture.wait,
    storageBudget(60000, (timeout) => timeouts.push(timeout), fixture.now),
  );
  assert.deepEqual(timeouts, [120000, 68400]);
});

test("an intentionally unbounded enclosing test remains unbounded", async () => {
  const fixture = clock(8400, 9000);
  const timeouts: number[] = [];
  await waitForStartup(
    fixture.read,
    fixture.wait,
    storageBudget(0, (timeout) => timeouts.push(timeout), fixture.now),
  );
  assert.deepEqual(timeouts, []);
});
