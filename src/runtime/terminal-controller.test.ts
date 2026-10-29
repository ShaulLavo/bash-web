import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import type { RootPreparationCompletion, RootDescendantPreparation } from "waffle";
import {
  attachTerminal,
  attachTerminalInput,
  captureTerminalProcessLifetime,
  createTerminalInputPolicy,
  createTerminalSession,
  claimTerminalAuthority,
  type TerminalMember,
} from "waffle/browser/runtime-terminals";
import { DescriptorTable } from "waffle/core/descriptors";
import { createFilesystemIdentity, revokeFilesystem } from "waffle/fs/protocol";
import { ProcessIdentityAllocator } from "waffle/proc/identity";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessTable } from "waffle/proc/table";
import { requestSignal } from "waffle/proc/signals";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import type { ProcessContext } from "waffle/proc/types";
import {
  createWorkerProcessTransport,
  workerProcessState,
  WorkerProcessClient,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { SharedBridge, control } from "../bridge";
import { createTerminalController } from "./terminal-controller";
import { TerminalOperationError, terminalValue } from "./terminal-producer";
import { createShellTerminals } from "./terminal-endpoints";
import { createTerminalAdmission } from "./terminal-admission";

const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
async function changed(cells: Int32Array, index: number) {
  while (!Atomics.load(cells, index)) {
    const wait = Atomics.waitAsync(cells, index, 0);
    if (wait.async) await wait.value;
  }
}
type FixtureOptions = {
  expectedFailures?: readonly unknown[];
  launch?(process: ProcessContext): void;
  before?: RootDescendantPreparation["run"];
  after?: RootDescendantPreparation["run"];
  settled?: RootDescendantPreparation["settled"];
};
async function fixture(context: TestContext, options: FixtureOptions = {}) {
  const identities = new ProcessIdentityAllocator();
  const registry = new ExecutableRegistry();
  registry.register("unit", { adapter: "unit", module });
  const failures: unknown[] = [];
  const launched: number[] = [];
  const broker = new BrowserProcessBroker({
    identities,
    table: new ProcessTable(identities),
    registry,
    filesystem: {
      connect() {
        throw new Error("No filesystem consumer in this controller test");
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      async quiesce() {},
    },
    launch(process) {
      launched.push(process.pid);
      options.launch?.(process);
      return { terminate() {} };
    },
    onError() {},
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity: 64,
  });
  const bridge = new SharedBridge();
  const runtime = { disposed: false };
  const controller = createTerminalController(runtime, root, bridge, (error) =>
    failures.push(error),
  );
  controller.bind(broker);
  const filesystem = createFilesystemIdentity();
  root.data = { filesystem, ...controller.metadata };
  const preparation = controller.prepareDescendant;
  await broker.adoptRuntimeRoot(root, {
    filesystem,
    prepareDescendant: {
      terminal: preparation.terminal,
      run(descendant, turn) {
        options.before?.(descendant, turn);
        const result = preparation.run(descendant, turn);
        options.after?.(descendant, turn);
        return result;
      },
      settled(descendant, completion) {
        options.settled?.(descendant, completion);
        preparation.settled?.(descendant, completion);
      },
    },
    quiesce: controller.quiesce,
  });
  const supervisor = await broker.ready();
  supervisor.onChildExit((event) => controller.exited(event.pid));
  const input = attachTerminalInput(controller.metadata.terminalInput);
  const attachment = attachTerminal({
    context: controller.metadata.terminalContext,
    process: root,
    checkActive() {},
    policy: createTerminalInputPolicy({ input }),
  });
  const descriptors = new DescriptorTable();
  const notices: WorkerProcessMessage[] = [];
  const unused = (): never => {
    throw new Error("No descriptors in this controller test");
  };
  const reserve = (job = 0, parent: WorkerProcessTransport = root) => {
    const client = new WorkerProcessClient({
      transport: parent,
      descriptors,
      codec: { import: unused, export: unused, discard: unused },
      prepareSpawn: () => ({
        data: { filesystem: createFilesystemIdentity(), ...controller.metadata },
      }),
      postMessage(message) {
        notices.push(message);
      },
    });
    const pid = client.spawn(parent.pid, {
      executable: "unit",
      argv: [],
      env: {},
      cwd: "/",
      job,
      fds: [],
    });
    const message = notices.shift();
    assert.ok(message?.operation === "spawn");
    return { pid, transport: message.transport, message, parent };
  };
  const start = async (child: ReturnType<typeof reserve>) => {
    await broker.runtimeMessage(child.message, child.parent.pid);
    await supervisor.start(child.pid);
  };
  const authority = controller.prepareDescendant.terminal;
  const flush = async () => {
    // Existing controller tasks enqueue their next granted turn in the preceding microtask.
    for (let step = 0; step < 8; step++)
      terminalValue(await authority.control(() => ({ kind: "ok", value: undefined })));
  };
  const beforeStop: (() => Promise<void>)[] = [];
  context.after(async () => {
    for (const cleanup of beforeStop) await cleanup();
    controller.stop();
    await broker.dispose();
    await controller.quiesce();
    attachment.dispose();
    descriptors.dispose();
    assert.deepEqual(failures, options.expectedFailures ?? []);
  });
  return {
    root,
    bridge,
    controller,
    broker,
    supervisor,
    authority,
    attachment,
    input,
    reserve,
    start,
    flush,
    launched,
    failures,
    runtime,
    beforeStop,
  };
}

async function finishHolder(
  cells: Int32Array,
  worker: Worker,
  lifetime: ReturnType<typeof captureTerminalProcessLifetime>,
) {
  Atomics.store(cells, 1, 1);
  Atomics.notify(cells, 1);
  await changed(cells, 3);
  await lifetime.quiesce();
  await worker.terminate();
  lifetime.stopped();
}

async function startPair(f: Awaited<ReturnType<typeof fixture>>) {
  const first = f.reserve();
  const second = f.reserve(workerProcessState(first.transport).job);
  await Promise.all([f.start(first), f.start(second)]);
  return { first, second };
}

test("real controller admission waits for a live holder and runs once before adapter entry", async (context) => {
  let calls = 0;
  const f = await fixture(context, {
    before() {
      calls++;
      return { kind: "ok", value: undefined };
    },
  });
  const holder = f.reserve();
  await f.start(holder);
  calls = 0;
  f.launched.length = 0;
  const lifetime = captureTerminalProcessLifetime({
    process: holder.transport,
    terminals: [{ identity: f.attachment.identity, inputs: [f.input] }],
  });
  assert.equal(f.bridge.send(Uint8Array.of(65)), 1);
  const flag = new SharedArrayBuffer(16);
  const cells = new Int32Array(flag);
  const worker = new Worker(
    new URL("../../tests/helpers/terminal-controller-holder.ts", import.meta.url),
    {
      workerData: {
        context: f.controller.metadata.terminalContext,
        process: holder.transport,
        input: f.input.buffer,
        flag,
      },
      execArgv: [],
    },
  );
  f.beforeStop.push(async () => {
    await finishHolder(cells, worker, lifetime);
    f.supervisor.exit(holder.pid, 0);
    await f.supervisor.waitForExit(f.root.pid, holder.pid);
  });
  await changed(cells, 0);
  const child = f.reserve();
  const pending = f.start(child);
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.deepEqual(f.launched, []);
  Atomics.store(cells, 1, 1);
  Atomics.notify(cells, 1);
  await pending;
  assert.equal(calls, 1);
  assert.deepEqual(f.launched, [child.pid]);
  assert.equal(Atomics.load(cells, 2), 1);
});

for (const variant of ["not-entered", "adapter-invoked"] as const) {
  test(`committed ${variant} membership reaches one ordinary exit cleanup`, async (context) => {
    const events: string[] = [];
    let broker: BrowserProcessBroker;
    const f = await fixture(context, {
      launch() {
        if (variant === "adapter-invoked") throw new Error("Intentional adapter rejection");
      },
      after(descendant, turn) {
        if (variant === "not-entered")
          turn.publish(() => {
            const transport = broker.transportFor(descendant.pid);
            assert.ok(transport);
            requestSignal(workerProcessState(transport).signals, 9);
          });
        return { kind: "ok", value: undefined };
      },
      settled(_descendant, completion: RootPreparationCompletion) {
        events.push(completion.kind === "committed" ? completion.entry : "rolled-back");
      },
    });
    broker = f.broker;
    f.supervisor.onChildExit(() => events.push("exit"));
    const child = f.reserve();
    await f.start(child);
    await f.supervisor.waitForExit(f.root.pid, child.pid);
    await f.flush();
    assert.deepEqual(events, [variant, "exit"]);
    assert.equal(f.launched.length, variant === "not-entered" ? 0 : 1);
    assert.equal(f.bridge.send(Uint8Array.of(66)), 1);
    const byte = new Uint8Array(1);
    assert.equal(f.attachment.resolve(0).tryRead!([byte]), 1);
    assert.equal(byte[0], 66);
  });
}

for (const stage of ["group", "root", "member", "background", "selection"] as const) {
  test(`cancellation after admission ${stage} rolls back without local ownership or entry`, async (context) => {
    const events: string[] = [];
    const f = await fixture(context, {
      settled(_descendant, completion) {
        events.push(completion.kind);
        assert.equal(completion.receipt.phase, "rolled-back");
      },
    });
    const child = f.reserve(stage === "background" ? -1 : 0);
    assert.equal(workerProcessState(child.transport).jobForeground, stage !== "background");
    const cancel = () => requestSignal(workerProcessState(child.transport).signals, 9);
    const create = f.authority.createGroup.bind(f.authority);
    context.mock.method(f.authority, "createGroup", (...args: Parameters<typeof create>) => {
      const result = create(...args);
      if (stage === "group" && result.kind === "ok") cancel();
      return result;
    });
    const admit = f.authority.admitExisting.bind(f.authority);
    context.mock.method(f.authority, "admitExisting", (...args: Parameters<typeof admit>) => {
      const result = admit(...args);
      const expected = stage === "root" ? f.root.pid : child.pid;
      if (
        (stage === "root" || stage === "member") &&
        args[0].pid === expected &&
        result.kind === "ok"
      )
        cancel();
      return result;
    });
    const background = f.authority.startBackground.bind(f.authority);
    context.mock.method(
      f.authority,
      "startBackground",
      (...args: Parameters<typeof background>) => {
        const result = background(...args);
        if (stage === "background" && result.kind === "ok") cancel();
        return result;
      },
    );
    const transfer = f.authority.transfer.bind(f.authority);
    context.mock.method(f.authority, "transfer", (...args: Parameters<typeof transfer>) => {
      const result = transfer(...args);
      if (stage === "selection" && result.kind === "ok") cancel();
      return result;
    });
    f.supervisor.onChildExit(() => events.push("exit"));
    await f.start(child);
    await f.supervisor.waitForExit(f.root.pid, child.pid);
    await f.flush();
    assert.deepEqual(events, ["rolled-back", "exit"]);
    assert.deepEqual(f.launched, []);
    assert.equal(f.bridge.send(Uint8Array.of(65)), 1);
    const byte = new Uint8Array(1);
    assert.equal(f.attachment.resolve(0).tryRead!([byte]), 1);
    assert.equal(byte[0], 65);
  });
}

test("two queued descendants sharing a job publish one group and distinct members", async (context) => {
  const f = await fixture(context);
  let allocations = 0;
  const create = f.authority.createGroup.bind(f.authority);
  context.mock.method(f.authority, "createGroup", (...args: Parameters<typeof create>) => {
    allocations++;
    return create(...args);
  });
  const { first, second } = await startPair(f);
  assert.equal(allocations, 1);
  assert.deepEqual(new Set(f.launched), new Set([first.pid, second.pid]));
  f.supervisor.exit(first.pid, 0);
  await f.supervisor.waitForExit(f.root.pid, first.pid);
  await f.flush();
  f.supervisor.exit(second.pid, 0);
  await f.supervisor.waitForExit(f.root.pid, second.pid);
  await f.flush();
  assert.equal(f.bridge.send(Uint8Array.of(65)), 1);
  assert.equal(f.attachment.resolve(0).tryRead!([new Uint8Array(1)]), 1);
});

test("nested child exit restores the live ancestor selection through an owned turn", async (context) => {
  const f = await fixture(context);
  const parent = f.reserve();
  await f.start(parent);
  const descendant = f.reserve(0, parent.transport);
  await f.start(descendant);
  const policy = createTerminalInputPolicy({ input: f.input });
  const parentTerminal = attachTerminal({
    context: f.controller.metadata.terminalContext,
    process: parent.transport,
    policy,
    checkActive() {},
  });
  const childTerminal = attachTerminal({
    context: f.controller.metadata.terminalContext,
    process: descendant.transport,
    policy,
    checkActive() {},
  });
  context.after(() => {
    parentTerminal.dispose();
    childTerminal.dispose();
  });
  assert.equal(f.bridge.send(Uint8Array.of(65)), 1);
  assert.equal(parentTerminal.resolve(0).tryRead!([new Uint8Array(1)]), -6);
  assert.equal(childTerminal.resolve(0).tryRead!([new Uint8Array(1)]), 1);
  f.supervisor.exit(descendant.pid, 0);
  await f.supervisor.waitForExit(parent.pid, descendant.pid);
  await f.flush();
  assert.equal(f.bridge.send(Uint8Array.of(66)), 1);
  const byte = new Uint8Array(1);
  assert.equal(parentTerminal.resolve(0).tryRead!([byte]), 1);
  assert.equal(byte[0], 66);
});

async function selectedTerminal(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.authority.control(() => ({ kind: "ok", value: undefined }));
  assert.ok(result.receipt.state?.kind === "open");
  assert.ok(result.receipt.state.selection);
  return result.receipt.state.selection;
}

function exitOnRestoreTransfer(
  context: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  ancestor: WorkerProcessTransport,
) {
  const transfer = f.authority.transfer.bind(f.authority);
  let transfers = 0;
  context.mock.method(f.authority, "transfer", (...args: Parameters<typeof transfer>) => {
    if (++transfers === 1) {
      claimOutcome(workerProcessState(ancestor).signals.outcome, { kind: "exited", code: 0 });
      assert.equal(readOutcome(workerProcessState(f.root).signals.outcome), null);
    }
    return transfer(...args);
  });
  return () => transfers;
}

async function exitChild(
  f: Awaited<ReturnType<typeof fixture>>,
  child: ReturnType<Awaited<ReturnType<typeof fixture>>["reserve"]>,
) {
  f.supervisor.exit(child.pid, 0);
  await f.supervisor.waitForExit(child.parent.pid, child.pid);
  await f.flush();
  assert.deepEqual(f.failures, []);
}

test("a restore ancestor exiting between the liveness check and transfer restores the editor", async (context) => {
  const f = await fixture(context);
  const parent = f.reserve();
  await f.start(parent);
  const parentSelection = await selectedTerminal(f);
  const child = f.reserve(0, parent.transport);
  await f.start(child);
  const childSelection = await selectedTerminal(f);
  const transfers = exitOnRestoreTransfer(context, f, parent.transport);
  await exitChild(f, child);
  assert.equal(transfers(), 2, "the rejected ancestor is followed by one editor selection");
  const restored = await f.authority.control(() => ({ kind: "ok", value: undefined }));
  assert.equal(restored.receipt.phase, "committed");
  assert.ok(["retired", "stale"].includes(restored.receipt.group(childSelection.group)));
  assert.equal(restored.receipt.group(parentSelection.group), "active");
  assert.equal(f.bridge.send(Uint8Array.of(65)), 1);
  assert.equal(f.attachment.resolve(0).tryRead!([new Uint8Array(1)]), 1);
  f.supervisor.exit(parent.pid, 0);
  await f.supervisor.waitForExit(f.root.pid, parent.pid);
  await f.flush();
  const retired = await f.authority.control(() => ({ kind: "ok", value: undefined }));
  assert.ok(["retired", "stale"].includes(retired.receipt.group(parentSelection.group)));
  assert.equal(readOutcome(workerProcessState(f.root).signals.outcome), null);
});

test("a departed restore ancestor preserves a live outer group and its sibling", async (context) => {
  const f = await fixture(context);
  const outer = f.reserve();
  await f.start(outer);
  const sibling = f.reserve(workerProcessState(outer.transport).job);
  await f.start(sibling);
  const outerSelection = await selectedTerminal(f);
  const parent = f.reserve(0, outer.transport);
  await f.start(parent);
  const child = f.reserve(0, parent.transport);
  await f.start(child);
  const transfers = exitOnRestoreTransfer(context, f, parent.transport);
  const terminal = attachTerminal({
    context: f.controller.metadata.terminalContext,
    process: outer.transport,
    policy: createTerminalInputPolicy({ input: f.input }),
    checkActive() {},
  });
  context.after(() => terminal.dispose());
  await exitChild(f, child);
  assert.equal(transfers(), 2, "restoration advances once to the live outer group");
  const restored = await f.authority.control(() => ({ kind: "ok", value: undefined }));
  assert.equal(restored.receipt.phase, "committed");
  assert.equal(restored.receipt.group(outerSelection.group), "active");
  assert.equal(f.bridge.send(Uint8Array.of(66)), 1);
  const byte = new Uint8Array(1);
  assert.equal(terminal.resolve(0).tryRead!([byte]), 1);
  assert.equal(byte[0], 66);
  assert.equal(readOutcome(workerProcessState(outer.transport).signals.outcome), null);
  assert.equal(readOutcome(workerProcessState(sibling.transport).signals.outcome), null);
  f.supervisor.exit(parent.pid, 0);
  await f.supervisor.waitForExit(outer.pid, parent.pid);
  await f.flush();
  f.supervisor.exit(outer.pid, 0);
  f.supervisor.exit(sibling.pid, 0);
  await f.supervisor.waitForExit(f.root.pid, outer.pid);
  await f.supervisor.waitForExit(f.root.pid, sibling.pid);
  await f.flush();
  assert.equal(f.bridge.send(Uint8Array.of(67)), 1);
  assert.equal(f.attachment.resolve(0).tryRead!([byte]), 1);
  assert.equal(byte[0], 67);
});

test("a PROCESS_GONE control failure outside ancestor selection still fails a live root", async (context) => {
  await liveControlFailure(context, new TerminalOperationError("PROCESS_GONE"));
});

async function liveControlFailure(context: TestContext, failure: Error) {
  const f = await fixture(context, { expectedFailures: [failure] });
  context.mock.method(f.authority, "control", async () => {
    throw failure;
  });
  f.bridge.interrupt();
  f.bridge.discardInput();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readOutcome(workerProcessState(f.root).signals.outcome), null);
  assert.deepEqual(f.failures, [failure]);
}

async function barrier(bridge: SharedBridge) {
  while (Atomics.load(bridge.state, control.cancel) === 2) {
    const sequence = Atomics.load(bridge.state, control.wake);
    if (Atomics.load(bridge.state, control.cancel) !== 2) break;
    const wait = Atomics.waitAsync(bridge.state, control.wake, sequence);
    if (wait.async) await wait.value;
  }
}

for (const during of ["new foreground", "second interrupt"] as const) {
  test(`discard preserves completed drain and reset while handling ${during}`, async (context) => {
    const f = await fixture(context);
    const rootTerminal = createShellTerminals(
      { runtimeProcess: f.root },
      f.bridge.buffer,
      createTerminalAdmission(),
      f.bridge,
      () => {},
    );
    assert.ok(rootTerminal);
    context.after(() => rootTerminal.dispose());
    Atomics.store(f.bridge.state, control.phase, 1);
    assert.equal(f.bridge.send(new Uint8Array(8192).fill(65)), 8192);
    const controlTurn = f.authority.control.bind(f.authority);
    let setup = true;
    let child: ReturnType<typeof f.reserve> | undefined;
    context.mock.method(f.authority, "control", async (...args: Parameters<typeof controlTurn>) => {
      const result = await controlTurn(...args);
      if (!setup) return result;
      setup = false;
      if (during === "second interrupt") f.bridge.interrupt();
      else {
        child = f.reserve();
        await f.start(child);
      }
      return result;
    });
    f.bridge.interrupt();
    assert.equal(f.bridge.discardInput(), false);
    await barrier(f.bridge);
    rootTerminal.resolve(0).readiness();
    assert.equal(f.bridge.cancelled(), false);
    assert.equal(f.input.available(), 0);
    assert.equal(f.bridge.send(Uint8Array.of(66)), 1);
    const target = child
      ? attachTerminal({
          context: f.controller.metadata.terminalContext,
          process: child.transport,
          policy: createTerminalInputPolicy({ input: f.input }),
          checkActive() {},
        })
      : undefined;
    context.after(() => target?.dispose());
    const byte = new Uint8Array(1);
    assert.equal((target?.resolve(0) ?? rootTerminal.resolve(0)).tryRead!([byte]), 1);
    assert.equal(byte[0], 66);
    assert.equal(f.input.available(), 0);
  });
}

test("input observation resumes after an empty foreign Session releases only the input lock", async (context) => {
  const f = await fixture(context);
  const process = createWorkerProcessTransport();
  const display = createTerminalSession({
    controller: process,
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input: f.input });
  const authority = terminalValue(
    claimTerminalAuthority({ identity: display.identity, process, policy, checkActive() {} }),
  );
  const group = terminalValue(authority.createGroup({ initialMode: "raw" }));
  const member = terminalValue(authority.admitExisting({ group, pid: process.pid }));
  terminalValue(authority.acquire({ group, expected: null }));
  const lifetime = captureTerminalProcessLifetime({
    process,
    terminals: [{ identity: display.identity, inputs: [f.input] }],
  });
  const flag = new SharedArrayBuffer(16);
  const cells = new Int32Array(flag);
  const worker = new Worker(
    new URL("../../tests/helpers/terminal-input-holder.ts", import.meta.url),
    {
      workerData: { process, context: member.context, input: f.input.buffer, flag },
      execArgv: [],
    },
  );
  const root = attachTerminal({
    context: f.controller.metadata.terminalContext,
    process: f.root,
    checkActive() {},
    policy: { ...policy, inputReadiness: () => ({ readable: true, nbytes: 1 }) },
  });
  f.beforeStop.push(async () => {
    await finishHolder(cells, worker, lifetime);
    root.dispose();
    display.close("disposed");
  });
  await changed(cells, 0);
  const sequence = Atomics.load(f.input.notification, 0);
  const observed = f.input.observe();
  const attempt = await f.authority.control(() => ({
    kind: "ok",
    value: root.resolve(0).tryRead!([new Uint8Array(1)]),
  }));
  assert.equal(terminalValue(attempt), -6);
  const abort = new AbortController();
  const waiting = observed.wait({ signal: abort.signal });
  Atomics.store(cells, 1, 1);
  Atomics.notify(cells, 1);
  terminalValue(await waiting);
  assert.ok(
    Atomics.load(f.input.notification, 0) > sequence,
    "contended unlock publishes a wake without adding input data",
  );
  assert.equal(f.input.available(), 0);
  assert.equal(f.input.cancelled(), false);
  assert.equal(f.input.push(Uint8Array.of(65)), 1);
  const byte = new Uint8Array(1);
  assert.equal(root.resolve(0).tryRead!([byte]), 1);
  assert.equal(byte[0], 65);
});

test("an exit arriving during retirement is joined and cleaned without repeating admission", async (context) => {
  const f = await fixture(context);
  let owned: Parameters<typeof f.authority.startBackground>[0] | undefined;
  const create = f.authority.createGroup.bind(f.authority);
  context.mock.method(f.authority, "createGroup", (...args: Parameters<typeof create>) => {
    const result = create(...args);
    if (!owned && result.kind === "ok") owned = result.value;
    return result;
  });
  const { first, second } = await startPair(f);
  const run = f.authority.control.bind(f.authority);
  let turns = 0;
  context.mock.method(f.authority, "control", async (...args: Parameters<typeof run>) => {
    const result = await run(...args);
    if (++turns === 2) f.supervisor.exit(second.pid, 0);
    return result;
  });
  f.supervisor.exit(first.pid, 0);
  await f.supervisor.waitForExit(f.root.pid, first.pid);
  await f.flush();
  await f.supervisor.waitForExit(f.root.pid, second.pid);
  await f.flush();
  assert.ok(owned);
  const result = await f.authority.control(() => ({ kind: "ok", value: undefined }));
  assert.ok(["retired", "stale"].includes(result.receipt.group(owned)));
  assert.deepEqual(new Set(f.launched), new Set([first.pid, second.pid]));
});

test("exit after committed editor retirement reconciles the removed member without double cleanup", async (context) => {
  const f = await fixture(context);
  const child = f.reserve(workerProcessState(f.root).job);
  let member: TerminalMember | undefined;
  const admit = f.authority.admitExisting.bind(f.authority);
  context.mock.method(f.authority, "admitExisting", (...args: Parameters<typeof admit>) => {
    const result = admit(...args);
    if (args[0].pid === child.pid && result.kind === "ok") member = result.value.member;
    return result;
  });
  await f.start(child);
  assert.ok(member);
  const root = createShellTerminals(
    { runtimeProcess: f.root },
    f.bridge.buffer,
    createTerminalAdmission(),
    f.bridge,
    () => {},
  );
  assert.ok(root);
  context.after(() => root.dispose());
  Atomics.store(f.bridge.state, control.phase, 1);
  f.bridge.interrupt();
  f.bridge.discardInput();
  await barrier(f.bridge);
  root.resolve(0).readiness();
  const receipt = await f.authority.control(() => ({ kind: "ok", value: undefined }));
  assert.ok(["removed", "stale"].includes(receipt.receipt.member(member)));
  let removals = 0;
  const remove = f.authority.removeMember.bind(f.authority);
  context.mock.method(f.authority, "removeMember", (...args: Parameters<typeof remove>) => {
    if (args[0] === member) removals++;
    return remove(...args);
  });
  f.supervisor.exit(child.pid, 0);
  await f.supervisor.waitForExit(f.root.pid, child.pid);
  await f.flush();
  assert.equal(removals, 0, "a committed retired group already removed this membership");
  assert.equal(f.bridge.send(Uint8Array.of(65)), 1);
  assert.equal(root.resolve(0).tryRead!([new Uint8Array(1)]), 1);
});

function holdControl(context: TestContext, authority: RootDescendantPreparation["terminal"]) {
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = authority.control.bind(authority);
  context.mock.method(authority, "control", async (...args: Parameters<typeof run>) => {
    reached();
    await blocked;
    return run(...args);
  });
  return { started, release };
}

for (const operation of ["cleanup", "discard"] as const) {
  test(`root outcome claimed during ${operation} keeps normal exit free of task failure`, async (context) => {
    const f = await fixture(context);
    const child = f.reserve();
    await f.start(child);
    const held = holdControl(context, f.authority);
    if (operation === "cleanup") f.supervisor.exit(child.pid, 0);
    else {
      f.bridge.interrupt();
      f.bridge.discardInput();
    }
    await held.started;
    const winner = claimOutcome(workerProcessState(f.root).signals.outcome, {
      kind: "exited",
      code: 0,
    });
    held.release();
    // The real control's not-entered rejection and the task catch are microtasks in this turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(winner.kind, "exited");
    assert.equal(winner.code, 0);
    assert.equal(readOutcome(workerProcessState(f.root).signals.outcome)?.code, 0);
    assert.deepEqual(f.failures, [], "a claimed root exit is not a new signalFailure");
    assert.equal(f.failures[0], undefined, "normal root error remains unset");
  });
}

test("an unexpected task failure while the root is live still reaches the root failure boundary", async (context) => {
  await liveControlFailure(context, new Error("Unexpected live control failure"));
});

test("runtime disposal before task completion is shutdown rather than a new root failure", async (context) => {
  const f = await fixture(context);
  const held = holdControl(context, f.authority);
  f.bridge.interrupt();
  f.bridge.discardInput();
  await held.started;
  f.runtime.disposed = true;
  held.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readOutcome(workerProcessState(f.root).signals.outcome), null);
  assert.deepEqual(f.failures, []);
});

test("stale delegated acknowledgement does not change the current interrupt barrier", async (context) => {
  const f = await fixture(context);
  f.bridge.publishPrompt(0);
  Atomics.store(f.bridge.state, control.cancel, 1);
  const transfer = context.mock.method(
    f.authority,
    "transfer",
    f.authority.transfer.bind(f.authority),
  );
  f.controller.interruptDelegated(0n);
  await f.flush();
  assert.equal(Atomics.load(f.bridge.state, control.cancel), 1);
  assert.equal(transfer.mock.calls.length, 0);
  f.bridge.acknowledgeInputDiscard();
});

test("delegated acknowledgement waits for discard and clears only the completed barrier", async (context) => {
  const f = await fixture(context);
  f.bridge.publishPrompt(0);
  const child = f.reserve();
  await f.start(child);
  const childTerminal = createShellTerminals(
    { runtimeProcess: child.transport },
    f.bridge.buffer,
    createTerminalAdmission(),
    undefined,
    () => {},
  );
  assert.ok(childTerminal);
  context.after(() => childTerminal.dispose());
  childTerminal.ready();
  const states: number[] = [];
  const acknowledge = f.bridge.acknowledgeInputDiscard.bind(f.bridge);
  context.mock.method(f.bridge, "acknowledgeInputDiscard", () => {
    states.push(Atomics.load(f.bridge.state, control.cancel));
    acknowledge();
  });
  f.bridge.interrupt();
  f.bridge.discardInput();
  f.controller.interruptDelegated(1n);
  assert.equal(Atomics.load(f.bridge.state, control.cancel), 2);
  await barrier(f.bridge);
  await f.flush();
  assert.equal(Atomics.load(f.bridge.state, control.cancel), 0);
  assert.ok(states.includes(1));
  assert.ok(!states.includes(2));
  assert.equal(f.bridge.send(Uint8Array.of(120)), 1);
  const byte = new Uint8Array(1);
  assert.equal(childTerminal.resolve(0).tryRead!([byte]), 1);
  assert.equal(byte[0], 120);
});

test("delegated acknowledgement after target exit preserves the editor", async (context) => {
  const f = await fixture(context);
  f.bridge.publishPrompt(0);
  const child = f.reserve();
  await f.start(child);
  f.bridge.interrupt();
  f.bridge.discardInput();
  await barrier(f.bridge);
  await exitChild(f, child);
  f.controller.interruptDelegated(1n);
  await f.flush();
  assert.equal(Atomics.load(f.bridge.state, control.cancel), 0);
  assert.equal(f.bridge.send(Uint8Array.of(121)), 1);
  const byte = new Uint8Array(1);
  assert.equal(f.attachment.resolve(0).tryRead!([byte]), 1);
  assert.equal(byte[0], 121);
});

for (const timing of ["queued", "cleaned", "during-select"] as const) {
  test(`delegated acknowledgement restores a surviving pipeline reader: ${timing}`, async (context) => {
    const f = await fixture(context);
    f.bridge.publishPrompt(0);
    Atomics.store(f.bridge.state, control.phase, 2);
    const { first, second } = await startPair(f);
    const childTerminal = createShellTerminals(
      { runtimeProcess: second.transport },
      f.bridge.buffer,
      createTerminalAdmission(),
      undefined,
      () => {},
    );
    assert.ok(childTerminal);
    context.after(() => childTerminal.dispose());
    childTerminal.ready();
    f.bridge.interrupt();
    f.bridge.discardInput();
    await barrier(f.bridge);
    await f.flush();
    if (timing === "during-select") {
      const transfer = f.authority.transfer.bind(f.authority);
      let pending = true;
      context.mock.method(f.authority, "transfer", (options: Parameters<typeof transfer>[0]) => {
        if (pending) f.supervisor.exit(first.pid, 0);
        pending = false;
        return transfer(options);
      });
    }
    if (timing !== "cleaned") f.controller.interruptDelegated(1n);
    if (timing !== "during-select") f.supervisor.exit(first.pid, 0);
    await f.supervisor.waitForExit(f.root.pid, first.pid);
    await f.flush();
    if (timing === "cleaned") f.controller.interruptDelegated(1n);
    await f.flush();
    assert.equal(Atomics.load(f.bridge.state, control.cancel), 0);
    assert.equal(f.bridge.send(Uint8Array.of(120)), 1);
    const byte = new Uint8Array(1);
    assert.equal(childTerminal.resolve(0).tryRead!([byte]), 1);
    assert.equal(byte[0], 120);
  });
}

test("queued stale acknowledgement cannot clear the next generation interrupt", async (context) => {
  const f = await fixture(context);
  f.bridge.publishPrompt(0);
  const child = f.reserve();
  await f.start(child);
  f.bridge.interrupt();
  f.bridge.discardInput();
  await barrier(f.bridge);
  await f.flush();
  f.controller.interruptDelegated(1n);
  f.bridge.publishPrompt(7);
  f.bridge.interrupt();
  f.bridge.discardInput();
  await barrier(f.bridge);
  await f.flush();
  assert.equal(Atomics.load(f.bridge.state, control.cancel), 1);
  f.bridge.acknowledgeInputDiscard();
});
