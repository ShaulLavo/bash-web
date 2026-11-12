import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { HostCase } from "waffle/testing/page-runner";

export function hostCaseControl(overrides: Partial<HostCase> = {}): HostCase {
  return {
    workers: async () => assert.fail("unexpected browser Worker observation"),
    onWorker: () => assert.fail("unexpected browser Worker subscription"),
    waitForWorkerClose: async () => assert.fail("unexpected browser Worker close wait"),
    onRequest: () => assert.fail("unexpected browser request observation"),
    press: async () => assert.fail("unexpected key input"),
    signal: new AbortController().signal,
    remainingMs: () => 60_000,
    holdAsset: () => assert.fail("unexpected asset hold"),
    setTimeout: () => assert.fail("unexpected timeout change"),
    openPeer: async () => assert.fail("unexpected peer page"),
    allocateDatabase: async () => assert.fail("unexpected allocation"),
    task: async () => assert.fail("unexpected task"),
    script: async () => assert.fail("unexpected script"),
    sleep: (ms) => delay(ms),
    ...overrides,
  };
}
