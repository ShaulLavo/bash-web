import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecutableQuery } from "./executable-query";

test("executable query alias resolves and forwards only Waffle's existing guarded query functions", () => {
  const calls: number[][] = [];
  const call = (...args: number[]) => {
    calls.push(args);
    return -6;
  };
  const query = createExecutableQuery();
  assert.throws(() => query.namespace.access_start(1), /requires access_start/);
  query.bind({
    imports(module) {
      assert.deepEqual(
        WebAssembly.Module.imports(module),
        ["access_start", "access_take", "access_cancel", "poll"].map((name) => ({
          module: "runtime_proc",
          name,
          kind: "function",
        })),
      );
      assert.deepEqual(WebAssembly.Module.exports(module), []);
      return {
        runtime_proc: { access_start: call, access_take: call, access_cancel: call, poll: call },
      };
    },
  });
  assert.deepEqual(Object.keys(query.namespace), [
    "access_start",
    "access_take",
    "access_cancel",
    "poll",
  ]);
  assert.equal(query.namespace.access_start(1, 2, 3, 4, 1), -6);
  assert.equal(query.namespace.access_take(7), -6);
  assert.equal(query.namespace.access_cancel(7), -6);
  assert.equal(query.namespace.poll(8, 1, -1, 24), -6);
  assert.deepEqual(calls, [[1, 2, 3, 4, 1], [7], [7], [8, 1, -1, 24]]);
});

test("executable query alias fails rather than replacing missing process capabilities", () => {
  assert.throws(
    () => createExecutableQuery().bind({ imports: () => ({}) }),
    /requires access_start/,
  );
});
