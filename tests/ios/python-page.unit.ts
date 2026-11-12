import { test } from "bun:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import type { HostRequestCallback, HostWorker } from "waffle/testing/page-runner";
import { hostCaseControl } from "./host-case-control";
import { PythonPage } from "./python-page";
import { createPythonExpectContext } from "./python-expect";
import { createPythonAdapter } from "./python-adapter";

function control() {
  const baseline: HostWorker = Object.freeze({
    kind: "dedicated-worker",
    url: "https://fixture.test/baseline.js",
  });
  const child: HostWorker = Object.freeze({
    kind: "dedicated-worker",
    url: "https://fixture.test/child.js",
  });
  const snapshots: (readonly HostWorker[])[] = [[baseline], [baseline, child], [baseline], []];
  const events: string[] = [];
  let listener: HostRequestCallback | undefined;
  const context = createContext({ window: {} });
  const released = Promise.withResolvers<void>();
  const host = hostCaseControl({
    async workers() {
      events.push("actual-workers");
      return snapshots.shift() ?? [];
    },
    onRequest(callback) {
      events.push("subscribe");
      listener = callback;
      return () => {
        events.push("unsubscribe");
        return released.promise;
      };
    },
    async task(source) {
      if (source === 'await import("/python-tests.js");') {
        events.push("original-module");
        return;
      }
      await runInContext(`(async () => {${source}})()`, context);
    },
    async script(source) {
      if (source.includes("location.href")) return "/python-tests.html";
      return runInContext(`(() => {${source}})()`, context);
    },
  });
  return {
    page: new PythonPage(host),
    baseline,
    child,
    events,
    released,
    async request(url: string) {
      if (!listener) throw new Error("missing original listener");
      await listener(url);
    },
  };
}

test("original request callbacks retain every actual URL in order before fixture evaluation", async () => {
  const value = control();
  const urls: string[] = [];
  value.page.on("request", (request: { url(): string }) => {
    urls.push(request.url());
  });
  await value.request("http://host/python.wasm?a=1");
  await value.request("http://host/python.wasm?a=1");
  await value.request("http://host/python-stdlib.json");
  await value.page.goto("/python-tests.html");
  assert.deepEqual(urls, [
    "http://host/python.wasm?a=1",
    "http://host/python.wasm?a=1",
    "http://host/python-stdlib.json",
  ]);
  assert.deepEqual(value.events.slice(0, 2), ["subscribe", "original-module"]);
  assert.throws(() => value.page.on("response", () => {}), /Unexpected/);
  await assert.rejects(value.page.goto("/python-tests.html"), /Unexpected/);
  let joined = false;
  const pending = value.page.disposeRequests().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  value.released.resolve();
  await pending;
  assert.equal(joined, true);
});

test("Worker snapshots preserve actual host object identity across original synchronous reads", async () => {
  const value = control();
  await value.page.refreshWorkers();
  const original = value.page.workers();
  assert.equal(original[0], value.baseline);
  await value.page.evaluate(() => ({ error: undefined, status: 0 }));
  assert.equal(value.page.workers()[0], original[0]);
  assert.equal(value.page.workers()[1], value.child);
  await value.page.refreshWorkers();
  assert.equal(value.page.workers()[0], original[0]);
  const context = createPythonExpectContext(() => value.page.refreshWorkers());
  await context.expect.poll(() => value.page.workers().length).toBe(0);
  context.finish();
});

test("both complete host cases declare actual browser observation before any navigation", async () => {
  const adapter = await createPythonAdapter("/tmp/python-case-control.json");
  const cases = adapter.inventory();
  assert.deepEqual(
    cases.map((entry) => entry.id),
    ["PY01", "PY02"],
  );
  for (const entry of cases) {
    assert.equal(entry.observation, "workers-and-requests");
    assert.equal(typeof entry.drive, "function");
  }
  const budgets = adapter.budgets(cases.length);
  assert.equal(budgets.case, 60_000);
  assert.equal(budgets.operation, undefined);
  assert.equal(budgets.teardown, 60_000);
});
