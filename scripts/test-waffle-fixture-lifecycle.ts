import assert from "node:assert/strict";
import test from "node:test";
import { createWaffleFixture } from "./waffle-fixture-lifecycle.ts";

type FakeRuntime = { dispose(): Promise<void> };

function context() {
  let cleanup: (() => Promise<void>) | undefined;
  const value = {
    after(callback: () => Promise<void>) {
      cleanup = callback;
    },
  };
  return {
    value,
    async cleanup() {
      assert.ok(cleanup);
      await cleanup();
    },
  };
}

function dependencies(
  calls: string[],
  createRuntime: () => FakeRuntime,
  stopNodeWorkers: () => Promise<void> = async () => {
    calls.push("stop-workers");
  },
) {
  return {
    installNodeWorkers: () => calls.push("install"),
    createRuntime,
    stopNodeWorkers,
    liveNodeWorkers: () => {
      calls.push("live");
      return 0;
    },
  };
}

test("setup failure still runs registered worker cleanup", async () => {
  const calls: string[] = [];
  const setupError = new Error("setup failed");
  const state = context();
  await assert.rejects(
    createWaffleFixture(
      state.value,
      dependencies(calls, () => {
        calls.push("create");
        throw setupError;
      }),
    ),
    setupError,
  );
  await state.cleanup();
  assert.deepEqual(calls, ["install", "create", "stop-workers", "live"]);
});

test("stop failure does not skip runtime or worker cleanup", async () => {
  const calls: string[] = [];
  const stopError = new Error("stop failed");
  const state = context();
  const fixture = await createWaffleFixture(
    state.value,
    dependencies(calls, () => ({
      async dispose() {
        calls.push("dispose");
      },
    })),
  );
  fixture.setStop(() => {
    calls.push("stop");
    throw stopError;
  });
  await assert.rejects(state.cleanup(), stopError);
  assert.deepEqual(calls, ["install", "stop", "dispose", "stop-workers", "live"]);
});

test("cleanup preserves the first failure even when it is falsy", async () => {
  const calls: string[] = [];
  const state = context();
  const fixture = await createWaffleFixture(
    state.value,
    dependencies(calls, () => ({
      async dispose() {
        calls.push("dispose");
        throw new Error("later failure");
      },
    })),
  );
  fixture.setStop(() => {
    calls.push("stop");
    throw 0;
  });
  await assert.rejects(state.cleanup(), (error) => error === 0);
  assert.deepEqual(calls, ["install", "stop", "dispose", "stop-workers", "live"]);
});
