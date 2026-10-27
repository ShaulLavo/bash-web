import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerDiagnostics, describeError, verifyPageDiagnostics } from "./diagnostics.mjs";

test("unknown broker errors are captured without throwing from the callback", () => {
  for (const error of [
    null,
    undefined,
    "unexpected",
    new Error("unexpected"),
    Object.create(null),
  ]) {
    const diagnostics = createBrokerDiagnostics();
    assert.doesNotThrow(() => diagnostics.onError(error));
    assert.throws(() => diagnostics.verify([]), /unexpected broker diagnostic/);
  }
});

test("expected negative admission is classified and counted exactly once", () => {
  const diagnostics = createBrokerDiagnostics();
  diagnostics.onError(
    new Error("Cannot instrument WebAssembly: reserved import namespace runtime_proc"),
  );
  diagnostics.verify(["raw-admission"]);
  diagnostics.onError(null);
  assert.throws(() => diagnostics.verify(["raw-admission"]), /unexpected broker diagnostic: null/);
});

test("missing, duplicate and unrelated known diagnostics fail", () => {
  const diagnostics = createBrokerDiagnostics();
  assert.throws(() => diagnostics.verify(["raw-admission"]), /got 0/);
  diagnostics.onError(
    new Error("Cannot instrument WebAssembly: reserved import namespace runtime_proc"),
  );
  diagnostics.onError(
    new Error("Cannot instrument WebAssembly: reserved import namespace runtime_proc"),
  );
  assert.throws(() => diagnostics.verify(["raw-admission"]), /got 2/);
  assert.throws(() => diagnostics.verify(["missing-entry"]), /unexpected broker diagnostic/);
});

test("console and page errors fail the runner", () => {
  verifyPageDiagnostics([]);
  assert.throws(() => verifyPageDiagnostics(["error: unexpected"]), /unexpected page diagnostic/);
  assert.throws(
    () => verifyPageDiagnostics(["pageerror: unexpected"]),
    /unexpected page diagnostic/,
  );
  assert.equal(describeError(null), "null");
});
