import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartupDiagnostics, markStartup, type StartupStage } from "./startup-diagnostics";

test("startup snapshots retain only the first timestamp per stage and copy their data", () => {
  const diagnostics = createStartupDiagnostics(3);
  diagnostics.observe("runtime-lease-requested", 100);
  diagnostics.observe("runtime-lease-requested", 200);
  diagnostics.observe("terminal-open-requested", 50);
  const snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.pending, ["terminal-open-requested", "runtime-lease-requested"]);
  assert.deepEqual(snapshot.last, { stage: "runtime-lease-requested", timestamp: 100 });
  snapshot.stages["runtime-lease-requested"] = 900;
  assert.equal(diagnostics.snapshot().stages["runtime-lease-requested"], 100);
  diagnostics.observe("runtime-lease-resolved", 250);
  assert.deepEqual(diagnostics.snapshot().pending, ["terminal-open-requested"]);
});

test("stopped startup generations ignore late callbacks and new starts have no past stages", () => {
  const previous = createStartupDiagnostics(1);
  previous.observe("session-create-requested", 100);
  previous.stop();
  const next = createStartupDiagnostics(2);
  previous.observe("session-create-resolved", 200);
  assert.equal(previous.snapshot().stages["session-create-resolved"], undefined);
  assert.deepEqual(next.snapshot(), { generation: 2, stages: {}, pending: [], last: undefined });
});

test("startup markers use the high-resolution epoch clock and do not await observers", async () => {
  const diagnostics = createStartupDiagnostics(1);
  const before = performance.timeOrigin + performance.now();
  markStartup(diagnostics.observe, "runtime-lease-requested");
  markStartup(diagnostics.observe, "runtime-lease-resolved");
  const after = performance.timeOrigin + performance.now();
  const stages = diagnostics.snapshot().stages;
  assert.ok(stages["runtime-lease-requested"]! >= before);
  assert.ok(stages["runtime-lease-resolved"]! <= after);
  assert.ok(stages["runtime-lease-resolved"]! >= stages["runtime-lease-requested"]!);
  assert.doesNotThrow(() =>
    markStartup(() => {
      throw new Error("observer");
    }, "runtime-lease-requested"),
  );
  markStartup(() => Promise.reject(new Error("async observer")), "runtime-lease-requested");
  markStartup(() => new Promise(() => {}), "runtime-lease-resolved");
  await Promise.resolve();
  assert.deepEqual(diagnostics.snapshot().pending, []);
});

test("invalid timestamps cannot contaminate startup snapshots", () => {
  const diagnostics = createStartupDiagnostics(1);
  for (const timestamp of [NaN, Infinity, -1])
    diagnostics.observe("session-create-requested", timestamp);
  assert.deepEqual(diagnostics.snapshot().stages, {});
});

test("runtime milestones preserve worker timestamps and pair only observed waits", () => {
  const diagnostics = createStartupDiagnostics(1);
  diagnostics.observe("filesystem-worker-created", 100);
  diagnostics.observe("filesystem-connect-requested", 110);
  diagnostics.observe("filesystem-connected", 120);
  diagnostics.observe("indexeddb-open-requested", 130);
  diagnostics.observe("indexeddb-open-resolved", 140);
  diagnostics.observe("filesystem-lock-requested", 150);
  assert.deepEqual(diagnostics.snapshot().pending, ["filesystem-lock-requested"]);
  assert.equal(diagnostics.snapshot().stages["filesystem-lock-acquired"], undefined);
  diagnostics.observe("filesystem-lock-acquired", 160);
  diagnostics.observe("filesystem-epoch-requested", 170);
  assert.deepEqual(diagnostics.snapshot().pending, ["filesystem-epoch-requested"]);
  diagnostics.observe("filesystem-epoch-resolved", 180);
  diagnostics.observe("filesystem-ready", 190);
  assert.deepEqual(diagnostics.snapshot().pending, []);
  assert.equal(diagnostics.snapshot().stages["filesystem-connected"], 120);
  assert.deepEqual(diagnostics.snapshot().last, { stage: "filesystem-ready", timestamp: 190 });
});

test("untyped observers cannot grow the fixed stage map with arbitrary names", () => {
  const diagnostics = createStartupDiagnostics(1);
  for (let index = 0; index < 1000; index++)
    diagnostics.observe(`unknown-${index}` as StartupStage, index);
  assert.deepEqual(diagnostics.snapshot().stages, {});
  assert.equal(diagnostics.snapshot().last, undefined);
});

test("a stopped generation rejects late runtime completions without fabricating earlier stages", () => {
  const previous = createStartupDiagnostics(1);
  previous.observe("filesystem-lock-requested", 100);
  previous.stop();
  previous.observe("filesystem-lock-acquired", 200);
  assert.deepEqual(previous.snapshot().pending, ["filesystem-lock-requested"]);
  const borrowed = createStartupDiagnostics(2);
  borrowed.observe("shell-registration-requested", 250);
  assert.deepEqual(Object.keys(borrowed.snapshot().stages), ["shell-registration-requested"]);
});
