import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartupDiagnostics, markStartup } from "./startup-diagnostics";

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
