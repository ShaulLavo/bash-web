// Original worker telemetry regressions; no guest execution or filesystem service is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DescriptorTable } from "waffle/core/descriptors";
import { SharedBridge, control } from "../bridge";
import { shellExecutor, type ShellWorkerRequest } from "./worker";

function fixture(terminal?: SharedArrayBuffer) {
  const request = {
    terminal,
    memoryUsage: new SharedArrayBuffer(8),
  } as ShellWorkerRequest;
  const executor = shellExecutor(request);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  const context = {
    instance: { exports: { memory } },
    wasi: { descriptors: new DescriptorTable() },
  } as unknown as Parameters<NonNullable<typeof executor.instantiated>>[0];
  return { request, executor, memory, context };
}

test("root memory growth updates both terminal metrics and process diagnostics at host calls", () => {
  const terminal = new SharedBridge();
  const { request, executor, memory, context } = fixture(terminal.buffer);
  const imports = { probe: { boundary: () => 17 } };
  executor.imports!(imports, context);
  executor.instantiated!(context);
  assert.equal(Atomics.load(terminal.state, control.memory), 65536);
  assert.equal(Atomics.load(new BigInt64Array(request.memoryUsage!), 0), 65536n);
  memory.grow(1);
  assert.equal(imports.probe.boundary(), 17);
  assert.equal(Atomics.load(terminal.state, control.memory), 131072);
  assert.equal(Atomics.load(new BigInt64Array(request.memoryUsage!), 0), 131072n);
  memory.grow(1);
  executor.beforeFinish!();
  assert.equal(Atomics.load(terminal.state, control.memory), 196608);
  assert.equal(Atomics.load(new BigInt64Array(request.memoryUsage!), 0), 196608n);
  context.wasi.descriptors.dispose();
});

test("child memory telemetry never overwrites its parent's terminal metrics or phase", () => {
  const terminal = new SharedBridge();
  Atomics.store(terminal.state, control.memory, 12345);
  Atomics.store(terminal.state, control.phase, 2);
  const { request, memory, context } = fixture();
  request.runtimeProcess = { data: { shellTerminal: terminal.buffer } } as NonNullable<
    ShellWorkerRequest["runtimeProcess"]
  >;
  const executor = shellExecutor(request);
  executor.instantiated!(context);
  memory.grow(1);
  executor.beforeFinish!();
  assert.equal(Atomics.load(new BigInt64Array(request.memoryUsage!), 0), 131072n);
  assert.equal(Atomics.load(terminal.state, control.memory), 12345);
  assert.equal(Atomics.load(terminal.state, control.phase), 2);
  context.wasi.descriptors.dispose();
});
