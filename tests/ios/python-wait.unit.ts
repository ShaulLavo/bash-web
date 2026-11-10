import { test } from "bun:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { pythonWaitTask } from "./python-wait";

function control() {
  const lifetime = new AbortController();
  const frames = new Map<number, () => void>();
  let next = 0;
  const context = createContext({
    window: { __pythonAdapterSignal: lifetime.signal },
    ready: false,
    samples: 0,
    requestAnimationFrame(callback: () => void) {
      frames.set(++next, callback);
      return next;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    setTimeout: () => assert.fail("original readiness must use animation frames, not timers"),
  });
  const start = () =>
    runInContext(
      `(async () => {${pythonWaitTask(Function("samples++; return ready"))}})()`,
      context,
    );
  const frame = () => {
    const pending = Array.from(frames.values());
    frames.clear();
    for (const callback of pending) callback();
  };
  return { lifetime, frames, context, start, frame };
}

test("original readiness samples immediately and then on real animation frames without a new timer", async () => {
  const value = control();
  const pending = value.start();
  assert.equal(value.context.samples, 1);
  assert.equal(value.frames.size, 1);
  value.frame();
  assert.equal(value.context.samples, 2);
  value.context.ready = true;
  value.frame();
  await pending;
  assert.equal(value.context.samples, 3);
  assert.equal(value.frames.size, 0);
});

test("case teardown cancels a pending original readiness wait and releases its frame", async () => {
  const value = control();
  const pending = value.start();
  const reason = new Error("original wait cancelled with its case");
  value.lifetime.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(value.frames.size, 0);
});

test("a falsy original predicate failure cannot become successful readiness", async () => {
  for (const source of ["undefined", "null", "false", "0"]) {
    const value = control();
    const task = pythonWaitTask(Function(`throw ${source}`));
    const pending = runInContext(`(async () => {${task}})()`, value.context);
    const expected: unknown = runInContext(source, value.context);
    await assert.rejects(pending, (error: unknown) => error === expected);
    assert.equal(value.frames.size, 0);
  }
});
