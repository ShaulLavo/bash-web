import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  attachTerminal,
  createTerminalInputPolicy,
  terminalControls,
  type TerminalResult,
} from "waffle/browser/runtime-terminals";
import { DescriptorTable } from "waffle/core/descriptors";
import { claimOutcome } from "waffle/proc/outcome";
import {
  confirmWorkerProcessJob,
  createWorkerProcessTransport,
  workerProcessState,
  WorkerProcessClient,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { createTerminalProducer, type TerminalMetadata } from "./terminal-producer";
import { SharedBridge } from "../bridge";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

function fixture(context: TestContext, capacity?: number, initialMode: "raw" | "cooked" = "raw") {
  const root = createWorkerProcessTransport({ capacity: 8 });
  const producer = createTerminalProducer({
    controller: root,
    geometry: { columns: 80, rows: 24 },
    checkActive() {},
    capacity,
    initialMode,
  });
  context.after(() => producer.dispose());
  const attach = (process: WorkerProcessTransport, metadata: TerminalMetadata) => {
    const attachment = attachTerminal({
      context: structuredClone(metadata.terminalContext),
      process,
      checkActive() {},
      policy: createTerminalInputPolicy({ input: metadata.terminalInput }),
    });
    context.after(() => attachment.dispose());
    return attachment;
  };
  const attachment = attach(root, producer.rootMetadata);
  return { root, producer, attach, attachment, stream: attachment.resolve(0) };
}

function spawn(context: TestContext, root: WorkerProcessTransport, metadata: TerminalMetadata) {
  const descriptors = new DescriptorTable();
  context.after(() => descriptors.dispose());
  let transport: WorkerProcessTransport | undefined;
  const unused = (): never => {
    throw new Error("Membership-only spawn has no descriptor transfers");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { import: unused, export: unused, discard: unused },
    prepareSpawn: () => ({ data: structuredClone(metadata) }),
    postMessage(message: WorkerProcessMessage) {
      if (message.operation === "spawn") transport = message.transport;
    },
  });
  const pid = client.spawn(root.pid, {
    executable: "/membership-only",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  assert.ok(transport);
  const child = transport;
  const job = workerProcessState(child).job;
  context.after(() => {
    claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 0 });
    confirmWorkerProcessJob(child);
    client.wait(root.pid, pid);
    client.waitJob(root.pid, job);
  });
  return child;
}

test("root producer acquires a raw editor and publishes cloneable input metadata", (context) => {
  const { producer, stream } = fixture(context);
  assert.equal(producer.pushKeyboard(Uint8Array.of(13, 10)).kind, "ok");
  const bytes = new Uint8Array(2);
  assert.equal(stream.tryRead!([bytes]), 2);
  assert.deepEqual(bytes, Uint8Array.of(13, 10));
  assert.equal(stream.tryRead!([bytes]), -6);
  const controls = terminalControls(stream)!;
  must(producer.resize({ columns: 120, rows: 40 }));
  assert.equal(must(controls.snapshot()).geometry.columns, 120);
});

test("keyboard backpressure returns its accepted prefix and retries only the caller-owned tail", (context) => {
  const { producer, stream } = fixture(context, 8192);
  assert.equal(producer.pushKeyboard(new Uint8Array(4096).fill(65)).kind, "ok");
  const paste = new Uint8Array(8192).fill(66);
  const first = producer.pushKeyboard(paste);
  assert.ok(first.kind === "error");
  assert.deepEqual(first, { kind: "error", code: "AGAIN", accepted: 4096 });
  const bytes = new Uint8Array(4096);
  assert.equal(stream.tryRead!([bytes]), bytes.length);
  assert.ok(bytes.every((byte) => byte === 65));
  assert.deepEqual(producer.pushKeyboard(paste.subarray(first.accepted)), {
    kind: "ok",
    value: 4096,
  });
  for (let index = 0; index < 2; index++) {
    assert.equal(stream.tryRead!([bytes]), bytes.length);
    assert.ok(bytes.every((byte) => byte === 66));
  }
  assert.equal(stream.tryRead!([bytes]), -6);
});

test("planned direct membership gates input and foreground restoration uses the latest lease", (context) => {
  const { producer, root, stream, attach } = fixture(context);
  const group = must(producer.createGroup("cooked"));
  const plan = must(producer.planMember(group, producer.rootMember));
  const child = spawn(context, root, producer.metadata(plan.context));
  const member = must(producer.bindMember(plan.member, child.pid));
  const attachment = attach(child, producer.metadata(member.context));
  must(producer.select(group));
  must(attachment.ready());
  assert.equal(producer.pushKeyboard(Uint8Array.of(65, 13)).kind, "ok");
  const bytes = new Uint8Array(4);
  assert.equal(stream.tryRead!([bytes]), -6);
  assert.equal(attachment.resolve(0).tryRead!([bytes]), 2);
  assert.deepEqual(bytes.subarray(0, 2), Uint8Array.of(65, 10));
  must(producer.removeMember(member.member));
  must(producer.select(producer.editor));
  must(producer.retireGroup(group, "completed"));
  assert.equal(producer.pushKeyboard(Uint8Array.of(66)).kind, "ok");
  assert.equal(stream.tryRead!([bytes]), 1);
  assert.equal(bytes[0], 66);
});

test("existing direct members can start in the background without consuming editor input", (context) => {
  const { producer, root, stream, attach } = fixture(context);
  const group = must(producer.createGroup("cooked"));
  const canceled = must(producer.planMember(group, producer.rootMember));
  must(producer.cancelPlan(canceled.member));
  const child = spawn(context, root, producer.rootMetadata);
  const member = must(producer.admitExisting(group, child.pid));
  const attachment = attach(child, producer.metadata(member.context));
  must(producer.startBackground(group));
  assert.equal(producer.pushKeyboard(Uint8Array.of(65)).kind, "ok");
  const bytes = new Uint8Array(1);
  assert.equal(attachment.resolve(0).tryRead!([bytes]), -6);
  assert.equal(stream.tryRead!([bytes]), 1);
  must(producer.removeMember(member.member));
  must(producer.retireGroup(group, "start-failed"));
});

test("cancel, resume and true EOF preserve queued bytes without reopening a closed input", (context) => {
  const { producer, stream } = fixture(context);
  producer.pushKeyboard(Uint8Array.of(65));
  producer.cancelInput();
  const bytes = new Uint8Array(1);
  assert.equal(stream.tryRead!([bytes]), -11);
  assert.deepEqual(producer.pushKeyboard(bytes), { kind: "error", code: "CANCELED", accepted: 0 });
  producer.resumeInput();
  producer.closeInput();
  assert.equal(stream.tryRead!([bytes]), 1);
  assert.equal(bytes[0], 65);
  assert.equal(stream.tryRead!([bytes]), 0);
  producer.resumeInput();
  assert.deepEqual(producer.pushKeyboard(bytes), { kind: "error", code: "CLOSED", accepted: 0 });
  producer.dispose();
  producer.dispose();
  assert.equal(stream.tryRead!([bytes]), 0);
});

test("producer acquisition rejects a child controller without publishing terminal metadata", (context) => {
  const { producer, root } = fixture(context);
  const child = spawn(context, root, producer.rootMetadata);
  assert.throws(
    () =>
      createTerminalProducer({
        controller: child,
        geometry: { columns: 80, rows: 24 },
        checkActive() {},
      }),
    /terminal root is not live/,
  );
});

test("UI discard drains the shared cursor under a real raw lease without treating cancel as discard", (context) => {
  const { producer, stream } = fixture(context, undefined, "cooked");
  const controls = terminalControls(stream)!;
  assert.equal(producer.pushKeyboard(Uint8Array.of(65, 66, 10)).kind, "ok");
  const byte = new Uint8Array(1);
  assert.equal(stream.tryRead!([byte]), 1);
  assert.equal(byte[0], 65);
  assert.equal(producer.discardInput(producer.editor), true);
  assert.equal(producer.available(), 0);
  assert.equal(must(controls.snapshot()).mode, "raw");
  producer.pushKeyboard(Uint8Array.of(67));
  assert.equal(stream.tryRead!([byte]), 1);
  assert.equal(byte[0], 67);
});

test("restoring an editor creates an actual raw group instead of restoring its saved cooked mode", (context) => {
  const { producer, stream } = fixture(context, undefined, "cooked");
  const controls = terminalControls(stream)!;
  must(producer.restoreEditor());
  assert.equal(must(controls.snapshot()).mode, "raw");
  producer.pushKeyboard(Uint8Array.of(68));
  assert.equal(stream.tryRead!([new Uint8Array(1)]), 1);
});

test("connected bridge sends only to the admitted input and exposes no second readable queue", (context) => {
  const { producer, stream } = fixture(context);
  const bridge = new SharedBridge();
  const disconnect = bridge.connectInput({
    push(bytes) {
      const result = producer.pushKeyboard(bytes);
      return result.kind === "ok" ? result.value : result.accepted;
    },
    available: producer.available,
    wake: producer.wake,
    close: producer.closeInput,
    resize: (columns, rows) => {
      must(producer.resize({ columns, rows }));
    },
    interrupt() {},
    discard: () => true,
  });
  context.after(disconnect);
  assert.equal(bridge.send(Uint8Array.of(65)), 1);
  assert.equal(bridge.availableInput(), 1);
  assert.throws(() => bridge.receive(1), /admitted terminal endpoint/);
  assert.equal(bridge.tryRead([new Uint8Array(1)]), -8);
  const byte = new Uint8Array(1);
  assert.equal(stream.tryRead!([byte]), 1);
  assert.equal(byte[0], 65);
  bridge.close();
  assert.equal(bridge.send(byte), 0);
});
