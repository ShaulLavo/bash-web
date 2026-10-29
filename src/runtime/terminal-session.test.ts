import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  terminalControls,
  type TerminalResult,
} from "waffle/browser/runtime-terminals";
import { DescriptorTable } from "waffle/core/descriptors";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import {
  createWorkerProcessTransport,
  workerProcessState,
  WorkerProcessClient,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { SharedBridge, control } from "../bridge";
import { createShellTerminals } from "./terminal-endpoints";
import { createTerminalAdmission, quiesceTerminal } from "./terminal-admission";
import { terminalGuest } from "../../tests/helpers/terminal-wasi-guest";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

function terminalSession(context: TestContext) {
  const root = createWorkerProcessTransport({ capacity: 8 });
  const input = createTerminalInput();
  const display = createTerminalSession({
    controller: root,
    geometry: { columns: 80, rows: 24 },
  });
  context.after(() => display.close("disposed"));
  const policy = createTerminalInputPolicy({ input });
  const authority = must(
    claimTerminalAuthority({
      identity: display.identity,
      process: root,
      checkActive() {},
      policy,
    }),
  );
  const editor = must(authority.createGroup({ initialMode: "raw" }));
  const member = must(authority.admitExisting({ group: editor, pid: root.pid }));
  must(authority.acquire({ group: editor, expected: null }));
  const attachment = attachTerminal({
    context: member.context,
    process: root,
    checkActive() {},
    policy,
  });
  context.after(() => attachment.dispose());
  return { root, input, display, authority, editor, member, attachment };
}

test("an idle prompt requests raw mode once instead of on every host call", (context) => {
  const { root, input, member } = terminalSession(context);
  root.data = { terminalContext: member.context, terminalInput: input.buffer };
  const bridge = new SharedBridge();
  Atomics.store(bridge.state, control.phase, 1);
  const terminals = createShellTerminals(
    { runtimeProcess: root },
    bridge.buffer,
    createTerminalAdmission(),
    bridge,
    () => {},
  );
  assert.ok(terminals);
  context.after(() => terminals.dispose());
  terminals.ready();
  terminals.phase(1);
  const wakes = () => Atomics.load(bridge.state, control.wake);
  const idle = wakes();
  // The editor reads one byte per call, and every host import runs prepare first.
  for (let call = 0; call < 32; call++) terminals.prepare();
  assert.equal(wakes(), idle, "an idle prompt must not wake the page on every host call");

  Atomics.store(bridge.state, control.cancel, 2);
  terminals.prepare();
  assert.equal(Atomics.load(bridge.state, control.cancel), 2, "discard still in progress");
  Atomics.store(bridge.state, control.cancel, 1);
  terminals.prepare();
  assert.equal(
    Atomics.load(bridge.state, control.cancel),
    0,
    "the prompt acknowledges the discard",
  );

  const controls = terminalControls(terminals.resolve(0))!;
  terminals.phase(2);
  assert.equal(must(controls.snapshot()).mode, "cooked");
  terminals.phase(1);
  assert.equal(must(controls.snapshot()).mode, "raw", "each new prompt requests raw mode");
});

for (const target of [1, 2] as const) {
  test(`session terminal target ${target} preserves FD_READ and the shared fd0 input cursor`, (context) => {
    const { input, display, attachment } = terminalSession(context);
    const guest = terminalGuest({
      0: attachment.resolve(0),
      1: attachment.resolve(1),
      2: attachment.resolve(2),
    });
    context.after(() => guest.wasi.descriptors.dispose());
    const descriptor = guest.wasi.descriptors.get(target)!;
    const endpoint = descriptor.resource;
    assert.ok(endpoint.kind === "terminal");
    assert.equal(endpoint.readiness().readable, false);
    const keys = Uint8Array.of(65, 66, 67);
    assert.equal(must(pushTerminalInput(display, input, keys)), 3);
    assert.equal(endpoint.readiness().readable, true);
    assert.deepEqual(guest.poll(target), { error: 0, nbytes: 3n, flags: 0 });
    assert.equal(guest.io("fd_read", 0, 1), 0);
    assert.equal(guest.bytes[256], 65);
    assert.deepEqual(guest.poll(target), { error: 0, nbytes: 2n, flags: 0 });
    assert.notEqual(descriptor.rightsBase & 2n, 0n);
    assert.equal(
      guest.io("fd_read", target, 1),
      0,
      "read-capable terminal shares the input cursor",
    );
    assert.equal(guest.bytes[256], 66);
    assert.equal(guest.io("fd_read", 0, 1), 0);
    assert.equal(guest.bytes[256], 67);
    assert.equal(input.available(), 0);
    assert.equal(endpoint.readiness().readable, false);
    assert.equal(must(pushTerminalInput(display, input, Uint8Array.of(68))), 1);
    descriptor.rightsBase &= ~2n;
    assert.equal(guest.io("fd_read", target, 1), 76, "FD_READ denial leaves the input untouched");
    assert.equal(input.available(), 1);
    guest.wasi.descriptors.close(target);
    assert.equal(guest.io("fd_read", target, 1), 8, "closed terminal descriptors stay closed");
    assert.equal(input.available(), 1);
    assert.equal(guest.io("fd_read", 0, 1), 0);
    assert.equal(guest.bytes[256], 68);
    assert.equal(input.available(), 0);
  });
}

function outputMember(context: TestContext) {
  const session = terminalSession(context);
  const descriptors = new DescriptorTable();
  context.after(() => descriptors.dispose());
  let child: WorkerProcessTransport | undefined;
  const unexpected = (): never => {
    throw new Error("No descriptor transfer in this membership fixture");
  };
  const client = new WorkerProcessClient({
    transport: session.root,
    descriptors,
    codec: { import: unexpected, export: unexpected, discard: unexpected },
    postMessage(message) {
      if (message.operation === "spawn") child = message.transport;
    },
  });
  const pid = client.spawn(session.root.pid, {
    executable: "/owned-terminal-member",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  assert.ok(child);
  const admitted = must(session.authority.admitExisting({ group: session.editor, pid }));
  child.data = {
    terminalContext: admitted.context,
    terminalInput: session.input.buffer,
  };
  return { ...session, child, bridge: new SharedBridge(), admission: createTerminalAdmission() };
}

for (const target of [1, 2] as const) {
  test(`member retirement during fd${target} output leaves the root session readable`, (context) => {
    const { root, child, input, display, authority, attachment, bridge, admission } =
      outputMember(context);
    const retired = new Error("Member retired after Waffle's active check");
    let armed = false;
    let checks = 0;
    const checkActive = () => {
      if (!armed || ++checks <= 2) return;
      claimOutcome(workerProcessState(child).signals.outcome, { kind: "signaled", code: 2 });
      throw retired;
    };
    const terminals = createShellTerminals(
      { runtimeProcess: child },
      bridge.buffer,
      admission,
      undefined,
      checkActive,
    );
    assert.ok(terminals);
    context.after(() => terminals.dispose());
    terminals.ready();
    must(pushTerminalInput(display, input, Uint8Array.of(65)));
    armed = true;
    assert.throws(() => terminals.resolve(target).tryWrite!([Uint8Array.of(90)]), retired);
    assert.equal(readOutcome(workerProcessState(root).signals.outcome), null);
    const byte = new Uint8Array(1);
    assert.equal(attachment.resolve(0).tryRead!([byte]), 1, "child retirement is not root EOF");
    assert.equal(byte[0], 65);
    assert.equal(authority.createGroup({ initialMode: "raw" }).kind, "ok");
  });

  test(`fd${target} policy output stays fenced after admission revocation`, async (context) => {
    const { child, input, display, authority, attachment, bridge, admission } =
      outputMember(context);
    const terminals = createShellTerminals(
      { runtimeProcess: child },
      bridge.buffer,
      admission,
      undefined,
      () => {},
    );
    assert.ok(terminals);
    context.after(() => terminals.dispose());
    terminals.ready();
    must(pushTerminalInput(display, input, Uint8Array.of(65)));
    assert.equal(await quiesceTerminal(admission), true);
    const endpoint = terminals.resolve(target);
    assert.equal(endpoint.tryWrite!([Uint8Array.of(90)]), -29);
    assert.equal(endpoint.readiness().writable, false);
    assert.equal(bridge.drain().length, 0, "revoked output never reaches the shell ring");
    assert.equal(Atomics.load(new Int32Array(admission.state), 1), 0);
    assert.equal(attachment.resolve(0).tryRead!([new Uint8Array(1)]), 1);
    assert.equal(authority.createGroup({ initialMode: "raw" }).kind, "ok");
  });
}
