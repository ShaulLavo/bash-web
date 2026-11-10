import { test } from "bun:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { pythonCaseInventory } from "./python-contract";

async function bootstrap(close: () => Promise<void>) {
  let configuration: unknown;
  const result = await build({
    entryPoints: [new URL("./python-page-main.ts", import.meta.url).pathname],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "owned-page-module-control",
        setup(builder) {
          builder.onResolve({ filter: /^waffle\/testing\/page-runner\/page$/ }, () => ({
            path: "page",
            namespace: "control",
          }));
          builder.onLoad({ filter: /.*/, namespace: "control" }, () => ({
            contents:
              "export const isHostedPage=()=>true; export const cleanupStorage=async ledger=>ledger; export const startPage=value=>capture(value)",
            loader: "js",
          }));
        },
      },
    ],
  });
  const context = createContext({
    window: { pythonAcceptance: { close } },
    AbortController,
    Error,
    capture: (value: unknown) => {
      configuration = value;
    },
  });
  runInContext(result.outputFiles[0].text, context);
  assert.ok(
    configuration &&
      typeof configuration === "object" &&
      "list" in configuration &&
      "run" in configuration,
  );
  const list = configuration.list;
  assert.equal(typeof list, "function");
  if (typeof list !== "function") assert.fail("missing complete inventory");
  const run = configuration.run;
  assert.ok(run && typeof run === "object" && "teardown" in run);
  const teardown = run.teardown;
  if (typeof teardown !== "function") assert.fail("missing teardown");
  return {
    context,
    list: () => Reflect.apply(list, undefined, []),
    teardown: () => Reflect.apply(teardown, undefined, [{ id: "PY01" }]),
  };
}

test("the actual page bootstrap lists both original cases and waits for fixture close", async () => {
  const closed = Promise.withResolvers<void>();
  let calls = 0;
  const value = await bootstrap(() => {
    calls++;
    return closed.promise;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await value.list())), pythonCaseInventory);
  let settled = false;
  const pending = Promise.resolve(value.teardown()).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  assert.equal(runInContext("window.__pythonAdapterSignal.aborted", value.context), true);
  closed.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { id: "PY01", disposal: "pass" });
});

test("fixture close rejection stays a teardown failure rather than fabricated disposal", async () => {
  const failure = new Error("actual Python close failed");
  const value = await bootstrap(async () => {
    throw failure;
  });
  await assert.rejects(value.teardown(), (error: unknown) => error === failure);
});

test("the hosted asset set retains the full prepared payload and delegates only its document route", async () => {
  const { pythonHostAssets, pythonHostedPage } = await import("./python-bootstrap");
  const assets = await pythonHostAssets({
    scratch: ".scratch",
    signal: new AbortController().signal,
  });
  assert.equal(pythonHostedPage.path, "/python-tests.html");
  assert.equal(assets[pythonHostedPage.path], undefined);
  assert.equal(typeof assets[pythonHostedPage.script], "string");
  assert.equal(Object.keys(assets).length, 2658);
  assert.equal(
    Object.keys(assets).filter((path) => path.startsWith("/python-files/")).length,
    2650,
  );
});
