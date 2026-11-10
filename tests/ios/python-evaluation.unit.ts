import { test } from "bun:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { hostCaseControl } from "./host-case-control";
import { PythonEvaluation, pythonEvaluationValue } from "./python-evaluation";

function evaluation() {
  const events: string[] = [];
  const context = createContext({ window: {} });
  const host = hostCaseControl({
    async task(source) {
      events.push("task-start");
      await runInContext(`(async () => {${source}})()`, context);
      events.push("task-end");
    },
    async script(source) {
      events.push("script");
      const value = runInContext(`(() => {${source}})()`, context);
      return JSON.parse(
        JSON.stringify(value, (_key, item: unknown) => (item === undefined ? null : item)),
      );
    },
  });
  return { page: new PythonEvaluation(host), context, events };
}

test("JSON serialization preserves the original absent error rather than WebDriver null", async () => {
  const control = evaluation();
  assert.deepEqual(await control.page.evaluate(() => ({ status: 0, error: undefined })), {
    status: 0,
  });
  assert.equal(await control.page.evaluate(() => undefined), undefined);
  assert.equal(await control.page.evaluate(() => null), null);
  assert.equal(runInContext("window.__pythonValues.size", control.context), 0);
});

test("the actual asynchronous page result settles before the complete JSON read", async () => {
  const control = evaluation();
  const gate = Promise.withResolvers<void>();
  control.context.gate = gate.promise;
  const result = control.page.evaluate("not a function");
  await assert.rejects(result, /original Python page callback/);
  const pending = control.page.evaluate(Function("return gate.then(() => ({value: 'settled'}))"));
  await Promise.resolve();
  assert.deepEqual(control.events, ["task-start"]);
  gate.resolve();
  assert.deepEqual(await pending, { value: "settled" });
  assert.deepEqual(control.events, ["task-start", "task-end", "script"]);
});

test("complete large outputs and original JSON-safe arguments survive without caps", async () => {
  const control = evaluation();
  const value = { stdout: "0123456789".repeat(40000), stderr: "diagnostic\n".repeat(10000) };
  assert.deepEqual(await control.page.evaluate(Function("value", "return value"), value), value);
});

test("strict result decoding rejects missing, cloned-null and malformed envelopes", () => {
  for (const value of [undefined, null, {}, "null", "[]", "true", '{"extra":1}'])
    assert.throws(() => pythonEvaluationValue(value));
  assert.throws(() => pythonEvaluationValue("not JSON"));
  assert.equal(pythonEvaluationValue("{}"), undefined);
});
