import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedBridge, control, INPUT_CAPACITY } from "../bridge";
import { createBridgeTerminal } from "./runtime-terminals";
import { createTerminalAdmission, quiesceTerminal } from "./terminal-admission";

function cookedTerminal() {
  const bridge = new SharedBridge();
  Atomics.store(bridge.state, control.phase, 2);
  const admission = createTerminalAdmission();
  const input = createBridgeTerminal(bridge.buffer, 0, undefined, admission);
  return { bridge, admission, input };
}

function measureByteAllocations<T>(operation: () => T) {
  const original = globalThis.Uint8Array;
  const lengths: number[] = [];
  globalThis.Uint8Array = new Proxy(original, {
    construct(target, args, newTarget) {
      if (typeof args[0] === "number") lengths.push(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    return { value: operation(), lengths };
  } finally {
    globalThis.Uint8Array = original;
  }
}

function totalBytes(lengths: readonly number[]) {
  return lengths.reduce((total, length) => total + length, 0);
}

test("empty cooked read retries do not allocate byte buffers for guest capacity", (t) => {
  const { input } = cookedTerminal();
  const chunks = [new Uint8Array(1024 * 1024)];
  const measured = measureByteAllocations(() =>
    Array.from({ length: 100 }, () => input.tryRead!(chunks)),
  );
  t.diagnostic(
    `100 empty reads: ${measured.lengths.length} byte buffers, ${totalBytes(measured.lengths)} bytes`,
  );
  assert.deepEqual(measured.value, Array.from({ length: 100 }, () => -6));
  assert.equal(totalBytes(measured.lengths), 0);
});

test("tiny cooked input bounds storage despite large guest vectors", (t) => {
  const { bridge, input } = cookedTerminal();
  const first = new Uint8Array(1);
  const rest = new Uint8Array(1024 * 1024).fill(91);
  const chunks = [new Uint8Array(0), first, new Uint8Array(0), rest];
  assert.equal(bridge.send(Uint8Array.of(65)), true);
  const measured = measureByteAllocations(() => input.tryRead!(chunks));
  t.diagnostic(
    `one byte read: ${measured.lengths.length} byte buffers, ${totalBytes(measured.lengths)} bytes`,
  );
  assert.equal(measured.value, 1);
  assert.equal(first[0], 65);
  assert.equal(rest[0], 91);
  assert.equal(bridge.availableInput(), 0);
  assert.ok(measured.lengths.every((length) => length <= INPUT_CAPACITY));
  assert.ok(totalBytes(measured.lengths) <= INPUT_CAPACITY * 2);
});

test("full cooked ring bounds normalization storage and returns a short read", () => {
  const { bridge, input } = cookedTerminal();
  const destination = new Uint8Array(1024 * 1024).fill(91);
  const bytes = new Uint8Array(INPUT_CAPACITY).fill(65);
  assert.equal(bridge.send(bytes), true);
  const measured = measureByteAllocations(() => input.tryRead!([destination]));
  assert.equal(measured.value, INPUT_CAPACITY);
  assert.deepEqual(destination.subarray(0, INPUT_CAPACITY), bytes);
  assert.equal(destination[INPUT_CAPACITY], 91);
  assert.ok(measured.lengths.every((length) => length <= INPUT_CAPACITY));
  assert.ok(totalBytes(measured.lengths) <= INPUT_CAPACITY * 2);
});

test("zero-length cooked vectors preserve queued bytes and split CRLF state", () => {
  const { bridge, input } = cookedTerminal();
  const empty = new Uint8Array(0);
  const byte = new Uint8Array(1);
  assert.equal(bridge.send(Uint8Array.of(13, 10, 66)), true);
  assert.equal(input.tryRead!([empty, byte]), 1);
  assert.equal(byte[0], 10);
  const measured = measureByteAllocations(() => [
    input.tryRead!([]),
    input.tryRead!([empty, empty]),
  ]);
  assert.deepEqual(measured.value, [0, 0]);
  assert.equal(totalBytes(measured.lengths), 0);
  assert.equal(bridge.availableInput(), 2);
  assert.equal(input.tryRead!([byte]), -6);
  assert.equal(bridge.availableInput(), 1);
  assert.equal(input.tryRead!([empty, byte, empty]), 1);
  assert.equal(byte[0], 66);
});

test("cooked normalization preserves vector boundaries, wraparound and shared split CRLF", () => {
  const { bridge, input } = cookedTerminal();
  Atomics.store(bridge.state, control.inputRead, INPUT_CAPACITY - 2);
  Atomics.store(bridge.state, control.inputWrite, INPUT_CAPACITY - 2);
  const first = new Uint8Array(2);
  const second = new Uint8Array(2).fill(91);
  const empty = new Uint8Array(0);
  assert.equal(bridge.send(Uint8Array.of(65, 13, 10, 66, 13)), true);
  assert.equal(input.tryRead!([empty, first, empty, second, empty]), 3);
  assert.deepEqual(first, Uint8Array.of(65, 10));
  assert.deepEqual(second, Uint8Array.of(66, 91));
  assert.equal(bridge.availableInput(), 1);
  assert.equal(input.tryRead!([first.subarray(0, 1)]), 1);
  assert.equal(first[0], 10);
  const inherited = createBridgeTerminal(bridge.buffer, 0);
  assert.equal(bridge.send(Uint8Array.of(10, 255, 0)), true);
  assert.equal(inherited.tryRead!([empty, second]), 1);
  assert.equal(second[0], 255);
  assert.equal(inherited.tryRead!([first.subarray(0, 1)]), 1);
  assert.equal(first[0], 0);
});

test("empty cooked reads preserve contended-lock and EOF precedence", () => {
  const { bridge, input } = cookedTerminal();
  const chunks = [new Uint8Array(1024 * 1024)];
  bridge.close();
  Atomics.store(bridge.state, control.inputLock, 1);
  const contended = measureByteAllocations(() => input.tryRead!(chunks));
  assert.equal(contended.value, -6);
  assert.ok(totalBytes(contended.lengths) <= 1);
  assert.equal(Atomics.load(bridge.state, control.inputLock), 1);
  Atomics.store(bridge.state, control.inputLock, 0);
  const eof = measureByteAllocations(() => input.tryRead!(chunks));
  assert.equal(eof.value, 0);
  assert.ok(totalBytes(eof.lengths) <= 1);
  assert.equal(bridge.send(Uint8Array.of(13, 10)), true);
  assert.equal(input.tryRead!(chunks), 1);
  assert.equal(chunks[0][0], 10);
  assert.equal(input.tryRead!(chunks), 0);
});

test("cooked reads preserve cancellation, admission revocation and terminal teardown", async () => {
  const { bridge, admission, input } = cookedTerminal();
  const chunks = [new Uint8Array(1024 * 1024)];
  assert.equal(bridge.send(Uint8Array.of(13, 10)), true);
  bridge.interrupt();
  const cancelled = measureByteAllocations(() => input.tryRead!(chunks));
  assert.equal(cancelled.value, -6);
  assert.equal(totalBytes(cancelled.lengths), 0);
  assert.equal(bridge.availableInput(), 2);
  bridge.resumeInput();
  assert.equal(input.tryRead!(chunks), 1);
  assert.equal(await quiesceTerminal(admission), true);
  const revoked = measureByteAllocations(() => input.tryRead!(chunks));
  assert.equal(revoked.value, -29);
  assert.equal(totalBytes(revoked.lengths), 0);
  assert.equal(Atomics.load(new Int32Array(admission.state), 1), 0);
  const other = createBridgeTerminal(bridge.buffer, 0);
  Atomics.store(bridge.state, control.phase, 4);
  assert.equal(other.tryRead!(chunks), -29);
});

test("returning to editor mode resets cooked split CRLF state", () => {
  const { bridge, input } = cookedTerminal();
  const byte = new Uint8Array(1);
  bridge.send(Uint8Array.of(13));
  assert.equal(input.tryRead!([byte]), 1);
  assert.equal(byte[0], 10);
  Atomics.store(bridge.state, control.phase, 1);
  assert.equal(input.tryRead!([byte]), -6);
  Atomics.store(bridge.state, control.phase, 2);
  bridge.send(Uint8Array.of(10));
  assert.equal(input.tryRead!([byte]), 1);
  assert.equal(byte[0], 10);
});

function sendAfterEmptySnapshot<T>(bridge: SharedBridge, operation: () => T) {
  const original = SharedBridge.prototype.availableInput;
  let pending = true;
  SharedBridge.prototype.availableInput = function () {
    const available = original.call(this);
    if (pending && this.buffer === bridge.buffer && available === 0) {
      pending = false;
      assert.equal(bridge.send(Uint8Array.of(13, 10)), true);
    }
    return available;
  };
  try {
    return operation();
  } finally {
    SharedBridge.prototype.availableInput = original;
  }
}

test("input arriving after an empty snapshot still takes the cooked normalization path", () => {
  for (const closed of [false, true]) {
    const { bridge, input } = cookedTerminal();
    if (closed) bridge.close();
    const destination = new Uint8Array(2).fill(91);
    const count = sendAfterEmptySnapshot(bridge, () => input.tryRead!([destination]));
    assert.notEqual(count, 0);
    assert.ok(count === -6 || count === 1);
    if (count === -6) assert.equal(input.tryRead!([destination]), 1);
    assert.equal(destination[0], 10);
    assert.equal(destination[1], 91);
  }
});
