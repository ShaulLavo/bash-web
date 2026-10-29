// Original regression tests for the shell's terminal and guest metadata adapters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DescriptorTable, MAX_DESCRIPTOR } from "waffle/core/descriptors";
import { SharedBridge, control, INPUT_CAPACITY, OUTPUT_CAPACITY } from "../bridge";
import { TerminalNewlines } from "../shell-terminal-output";
import { shellTerminalImports } from "./guest-imports";
import { createBridgeTerminal } from "./runtime-terminals";
import {
  attachTerminal,
  createTerminalAdmission,
  quiesceTerminal,
  terminalSection,
} from "./terminal-admission";
import { createRuntimeTerminalCodec as createWaffleTerminalCodec } from "waffle/browser/runtime-terminals";

const unexpected = (): never => {
  throw new Error("Unexpected non-terminal descriptor");
};
const fallback = { export: unexpected, import: unexpected, discard: unexpected };

test("shared terminal input and output stay bounded, wrap and preserve binary bytes", () => {
  const bridge = new SharedBridge();
  const input = createBridgeTerminal(bridge.buffer, 0);
  const output = createBridgeTerminal(bridge.buffer, 1);
  assert.equal(input.tryRead!([new Uint8Array(1)]), -6);
  const first = new Uint8Array(INPUT_CAPACITY - 2).fill(7);
  assert.equal(bridge.send(first), first.length);
  assert.equal(bridge.send(new Uint8Array(3)), 0);
  assert.equal(input.tryRead!([new Uint8Array(first.length)]), first.length);
  const binary = Uint8Array.of(0, 255, 13, 10, 27);
  assert.equal(bridge.send(binary), binary.length);
  const read = new Uint8Array(binary.length);
  assert.equal(input.tryRead!([read]), binary.length);
  assert.deepEqual(read, binary);
  assert.equal(output.tryWrite!([new Uint8Array(OUTPUT_CAPACITY).fill(11)]), OUTPUT_CAPACITY);
  assert.equal(output.tryWrite!([Uint8Array.of(3)]), -6);
  bridge.drain(OUTPUT_CAPACITY);
  assert.equal(output.tryWrite!([binary]), binary.length);
  assert.deepEqual(bridge.drain(), binary);
  assert.equal(bridge.buffer.byteLength, 72 + INPUT_CAPACITY + OUTPUT_CAPACITY);
});

test("cancelled terminal input drops queued bytes after a contended lock releases", () => {
  const bridge = new SharedBridge();
  assert.equal(bridge.send(Uint8Array.of(65, 66)), Uint8Array.of(65, 66).length);
  Atomics.store(bridge.state, control.inputLock, 1);
  assert.equal(bridge.discardInput(), false);
  assert.equal(bridge.availableInput(), 2);
  Atomics.store(bridge.state, control.inputLock, 0);
  assert.equal(bridge.discardInput(), true);
  assert.equal(bridge.availableInput(), 0);
  assert.equal(bridge.tryRead([new Uint8Array(1)]), -6);
});

test("running shell reads terminal CR and CRLF as one LF while editor stays byte-exact", () => {
  const bridge = new SharedBridge();
  const input = createBridgeTerminal(bridge.buffer, 0);
  const editorBytes = Uint8Array.of(13, 10);
  bridge.send(editorBytes);
  const editorRead = new Uint8Array(editorBytes.length);
  assert.equal(input.tryRead!([editorRead]), editorBytes.length);
  assert.deepEqual(editorRead, editorBytes);

  Atomics.store(bridge.state, control.phase, 2);
  const commandBytes = Uint8Array.of(116, 101, 115, 116, 13, 10);
  bridge.send(commandBytes);
  const commandRead = new Uint8Array(commandBytes.length);
  assert.equal(input.tryRead!([commandRead]), 5);
  assert.deepEqual(commandRead.subarray(0, 5), Uint8Array.of(116, 101, 115, 116, 10));

  bridge.send(Uint8Array.of(13));
  const splitCr = new Uint8Array(1);
  assert.equal(input.tryRead!([splitCr]), 1);
  assert.deepEqual(splitCr, Uint8Array.of(10));
  bridge.send(Uint8Array.of(10));
  assert.equal(input.tryRead!([new Uint8Array(1)]), -6);
});

test("terminal admission is released even when a guest operation throws", async () => {
  const admission = createTerminalAdmission();
  assert.throws(
    () =>
      terminalSection(admission, () => {
        throw new Error("guest failure");
      }),
    /guest failure/,
  );
  assert.equal(Atomics.load(new Int32Array(admission.state), 1), 0);
  assert.equal(await quiesceTerminal(admission), true);
  assert.equal(
    terminalSection(admission, () => 19),
    -29,
  );
});

test("a crashed terminal section fails its bridge closed without stealing its ring lock", async () => {
  const admission = createTerminalAdmission();
  const bridge = new SharedBridge();
  attachTerminal(admission, bridge.buffer);
  Atomics.store(new Int32Array(admission.state), 1, 1);
  Atomics.store(bridge.state, control.outputLock, 1);
  assert.equal(await quiesceTerminal(admission, 0), false);
  assert.equal(bridge.closed(), true);
  assert.equal(Atomics.load(bridge.state, control.phase), 4);
  assert.equal(Atomics.load(bridge.state, control.outputLock), 1);
});

test("terminal destination survives Waffle controller re-export and arbitrary fd remapping", () => {
  const bridge = new SharedBridge();
  const admission = createTerminalAdmission();
  const controller = createWaffleTerminalCodec({ fallback });
  const original = new DescriptorTable();
  const initial = original.open(createBridgeTerminal(bridge.buffer, 2), 1n << 6n, 0n);
  original.inherit(2, original.get(initial)!);
  if (initial !== 2) original.close(initial);
  const guest = createWaffleTerminalCodec({
    fallback,
    descriptors: original,
    resolveTerminal: (target) => createBridgeTerminal(bridge.buffer, target, undefined, admission),
  });
  const token = guest.export(original.get(2)!, 20);
  const imported = controller.import(token, 20);
  const page = new DescriptorTable();
  page.inherit(77, {
    description: imported,
    resource: imported.resource,
    rightsBase: 1n << 6n,
    rightsInheriting: 0n,
  });
  const roundtrip = controller.export(page.get(77)!, 21);
  assert.deepEqual(roundtrip, { kind: "web-terminal", target: 2 });
  const final = guest.import(roundtrip, 21);
  const resource = final.resource;
  assert.equal(resource.kind, "terminal");
  if (resource.kind !== "terminal") throw new Error("Missing terminal");
  assert.equal(resource.tryWrite!([Uint8Array.of(0, 255)]), 2);
  assert.deepEqual(bridge.drain(), Uint8Array.of(0, 255));
  original.dispose();
  page.dispose();
  final.retain();
  final.drop();
});

test("shell metadata enumerates exact inherited fds rather than opening implicit stdio", () => {
  const inherited = [1, 3, 1000000, MAX_DESCRIPTOR];
  const imports = shellTerminalImports(undefined, inherited);
  assert.deepEqual(
    Array.from({ length: inherited.length + 1 }, (_, index) => imports.inherited_fd(index)),
    inherited.concat([-1]),
  );
  assert.equal(shellTerminalImports(undefined, []).inherited_fd(0), -1);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => shellTerminalImports().inherited_fd(index)),
    [0, 1, 2, -1],
  );
});

test("only the interactive root owns shell phase and columns follow its live terminal", () => {
  const bridge = new SharedBridge();
  const root = shellTerminalImports(bridge.buffer);
  Atomics.store(bridge.state, control.cols, 103);
  assert.equal(root.columns(), 103);
  root.phase(2, 99);
  assert.equal(Atomics.load(bridge.state, control.status), 0);
  assert.equal(Atomics.load(bridge.state, control.phase), 2);
  shellTerminalImports().phase(1, 0);
  assert.equal(Atomics.load(bridge.state, control.phase), 2);
  bridge.close();
  root.phase(1, 0);
  assert.equal(Atomics.load(bridge.state, control.phase), 2);
});

test("final terminal newline discipline is byte-exact across drains", () => {
  const discipline = new TerminalNewlines();
  const chunks: Uint8Array[] = [];
  discipline.write(Uint8Array.of(0, 255, 13), (bytes) => chunks.push(bytes));
  discipline.write(Uint8Array.of(10, 10, 27), (bytes) => chunks.push(bytes));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 13, 10, 13, 10, 27]));
});
