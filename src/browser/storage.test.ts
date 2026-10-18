import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRuntime, type Runtime, type SharedFilesystemState } from "waffle";
import { FilesystemError, type FilesystemConnection } from "waffle/fs/protocol";
import { FilesystemService } from "waffle/fs/service";
import { MemoryBackend } from "waffle/fs/backend";
import { BrowserSession } from "./session";
import { STORAGE_READY_TIMEOUT_MS, waitForStorage } from "./storage";

function storageWorker(context: TestContext) {
  const previousWorker = globalThis.Worker;
  const isolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const workers: StorageWorker[] = [];
  class StorageWorker extends EventTarget {
    connection?: FilesystemConnection;
    service = new FilesystemService(new MemoryBackend());
    initialization?: { storage: string; whenBusy?: string };
    disposalRequested = false;
    holdDisposal = false;
    terminated = false;
    constructor() {
      super();
      workers.push(this);
    }
    postMessage(message: {
      connect?: FilesystemConnection;
      storage?: string;
      whenBusy?: string;
      dispose?: boolean;
    }) {
      if (message.connect) {
        this.connection = message.connect;
        this.initialization = { storage: message.storage!, whenBusy: message.whenBusy };
      }
      if (message.dispose) {
        this.disposalRequested = true;
        if (!this.holdDisposal) queueMicrotask(() => this.finishDisposal());
      }
    }
    terminate() {
      this.terminated = true;
      this.service.dispose();
    }
    state(status: "waiting" | "ready") {
      if (status === "ready") this.service.connect(this.connection!);
      this.dispatchEvent(
        new MessageEvent("message", { data: { type: "filesystem-state", status } }),
      );
    }
    finishDisposal() {
      this.dispatchEvent(new MessageEvent("message", { data: { type: "filesystem-disposed" } }));
    }
  }
  globalThis.Worker = StorageWorker as unknown as typeof Worker;
  let runtime: Runtime | undefined;
  context.after(async () => {
    // The final worker abort follows admitted consumer fences, not the dispose() call.
    for (const worker of workers) worker.holdDisposal = false;
    const disposing = runtime?.dispose();
    for (const worker of workers) {
      if (worker.disposalRequested) worker.finishDisposal();
    }
    try {
      await disposing;
    } finally {
      for (const worker of workers) worker.connection?.port.close();
      globalThis.Worker = previousWorker;
      if (isolation) Object.defineProperty(globalThis, "crossOriginIsolated", isolation);
      else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    }
  });
  return {
    create(options: Parameters<typeof createRuntime>[0] = {}) {
      runtime = createRuntime({
        ...options,
        filesystem: { workerURL: "https://example.test/fs-worker.js", ...options.filesystem },
      });
      return { runtime, worker: workers.at(-1)! };
    },
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("waiting remains typed and pending until recovery reports ready, preserving the owner's observer", async (context) => {
  const fixture = storageWorker(context);
  const ownerStates: string[] = [];
  const owner = (state: SharedFilesystemState) => {
    ownerStates.push(state.status);
  };
  const { runtime, worker } = fixture.create({
    filesystem: { storage: "opfs", onStateChange: owner },
  });
  const states: string[] = [];
  let ready = false;
  const opening = waitForStorage(runtime, new AbortController().signal, (state) => {
    states.push(state.status);
  }).then(() => {
    ready = true;
  });
  worker.state("waiting");
  await turn();
  assert.equal(runtime.filesystem.state.status, "waiting");
  assert.equal(ready, false);
  assert.deepEqual(states, ["opening", "waiting"]);
  worker.state("ready");
  await opening;
  assert.deepEqual(states, ["opening", "waiting", "ready"]);
  assert.deepEqual(ownerStates, ["waiting", "ready"]);
  assert.equal(runtime.filesystem.onStateChange, owner);
});

test("shell startup timeout starts only after storage is ready", async (context) => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>(() => {});
  context.after(() => {
    globalThis.fetch = fetch;
  });
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create({ filesystem: { storage: "opfs" } });
  worker.state("waiting");
  let admitted = false;
  let rejected = false;
  const states: string[] = [];
  const starting = BrowserSession.create({
    runtime,
    cols: 80,
    rows: 24,
    startupTimeoutMs: 10,
    onOutput() {},
    onState(state) {
      states.push(state);
    },
  });
  const rejection = assert.rejects(starting, /Shell startup exceeded/).then(() => {
    rejected = true;
  });
  // A waiting session must not retain a shell consumer or issue filesystem requests yet.
  worker.connection!.port.addEventListener("message", () => {
    admitted = true;
  });
  worker.connection!.port.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(rejected, false);
  assert.equal(admitted, false);
  assert.equal(states.at(-1), "waiting");
  worker.state("ready");
  await rejection;
  assert.equal(admitted, true, "shell initialization begins once storage is ready");
});

test("runtime disposal revokes synchronously and awaits the final waiting-storage acknowledgement", async (context) => {
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create({ filesystem: { storage: "opfs" } });
  worker.holdDisposal = true;
  worker.state("waiting");
  const opening = waitForStorage(runtime, new AbortController().signal);
  const rejected = assert.rejects(opening, /storage was disposed/);
  let finished = false;
  const disposing = runtime.dispose().then(() => {
    finished = true;
  });
  assert.equal(runtime.disposed, true);
  assert.equal(worker.disposalRequested, false, "abort follows the runtime's consumer fences");
  await turn();
  assert.equal(worker.disposalRequested, true);
  await rejected;
  assert.equal(finished, false);
  assert.equal(worker.terminated, false);
  worker.finishDisposal();
  await disposing;
  assert.equal(worker.terminated, true);
  assert.equal(runtime.filesystem.state.status, "disposed");
});

for (const whenBusy of ["takeover", "wait"] as const) {
  test(`opening IndexedDB ${whenBusy} revokes queued work before joining an admitted consumer`, async (context) => {
    const fixture = storageWorker(context);
    const { runtime, worker } = fixture.create({ filesystem: { whenBusy } });
    let releaseStop!: () => void;
    const physicalStop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopping = false;
    runtime.retainConsumer({
      filesystem: runtime.filesystem.createIdentity(),
      revoke() {},
      async stop() {
        stopping = true;
        await physicalStop;
      },
    });
    const cancelled = assert.rejects(
      runtime.filesystem.mkdirp("/pending"),
      (error: unknown) => error instanceof FilesystemError && error.errno === 11,
    );
    const disposing = runtime.dispose();
    try {
      await cancelled;
      await turn();
      assert.equal(stopping, true);
      assert.equal(worker.disposalRequested, false, "the consumer still owns its stop fence");
      assert.equal(worker.terminated, false);
    } finally {
      releaseStop();
      await disposing;
    }
    assert.equal(worker.disposalRequested, true);
    assert.equal(worker.terminated, true);
  });
}

test("cancelling a waiting session detaches its observer without disposing the borrowed runtime", async (context) => {
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create({
    filesystem: { storage: "indexeddb", whenBusy: "wait" },
  });
  worker.state("waiting");
  const controller = new AbortController();
  const starting = BrowserSession.create({
    runtime,
    signal: controller.signal,
    cols: 80,
    rows: 24,
    onOutput() {},
    onState() {},
  });
  controller.abort(new Error("Host closed"));
  await assert.rejects(starting, /cancelled/);
  assert.equal(runtime.disposed, false);
  assert.equal(runtime.filesystem.onStateChange, undefined);
  assert.equal(worker.disposalRequested, false);
});

test("concurrent storage waiters detach without replacing the owner's observer", async (context) => {
  const fixture = storageWorker(context);
  const owner = () => {};
  const { runtime, worker } = fixture.create({
    filesystem: { storage: "opfs", onStateChange: owner },
  });
  const cancelled = new AbortController();
  const first = waitForStorage(runtime, cancelled.signal);
  const second = waitForStorage(runtime, new AbortController().signal);
  cancelled.abort(new Error("First consumer left"));
  await assert.rejects(first, /First consumer left/);
  assert.notEqual(runtime.filesystem.onStateChange, owner);
  worker.state("ready");
  await second;
  assert.equal(runtime.filesystem.onStateChange, owner);
});

test("initial storage opening has a separate generous readiness bound", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create({ filesystem: { storage: "opfs" } });
  let failed = false;
  const opening = waitForStorage(runtime, new AbortController().signal);
  const rejected = assert
    .rejects(opening, /Browser storage did not become ready within 60 seconds/)
    .then(() => {
      failed = true;
    });
  context.mock.timers.tick(STORAGE_READY_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(failed, false);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(runtime.filesystem.onStateChange, undefined);
  assert.equal(runtime.disposed, false, "the runtime still belongs to its application");
  assert.equal(worker.disposalRequested, false);
});

test("ownership waiting disarms the opening guard without starting the shell guard", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create({ filesystem: { storage: "opfs" } });
  let ready = false;
  const opening = waitForStorage(runtime, new AbortController().signal).then(() => {
    ready = true;
  });
  context.mock.timers.tick(1000);
  worker.state("waiting");
  context.mock.timers.tick(STORAGE_READY_TIMEOUT_MS * 3);
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(runtime.filesystem.state.status, "waiting");
  worker.state("ready");
  await opening;
});

for (const outcome of ["ready", "cancelled"] as const)
  test(`storage ${outcome} removes its opening timer and observer`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = storageWorker(context);
    const { runtime, worker } = fixture.create({ filesystem: { storage: "opfs" } });
    const clear = context.mock.method(globalThis, "clearTimeout");
    const controller = new AbortController();
    const opening = waitForStorage(runtime, controller.signal);
    if (outcome === "ready") {
      worker.state("ready");
      await opening;
    } else {
      controller.abort(new Error("Host left during opening"));
      await assert.rejects(opening, /Host left during opening/);
    }
    assert.equal(
      clear.mock.callCount(),
      1,
      "the scheduled timer must be cleared, not merely ignored later",
    );
    assert.notEqual(clear.mock.calls[0].arguments[0], undefined);
    assert.equal(runtime.filesystem.onStateChange, undefined);
    context.mock.timers.tick(STORAGE_READY_TIMEOUT_MS * 2);
  });

test("storage defaults are forwarded unchanged and OPFS takeover is rejected", async (context) => {
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create();
  assert.deepEqual(worker.initialization, { storage: "indexeddb", whenBusy: undefined });
  // Default IndexedDB startup is cancellable even before storage becomes ready.
  await runtime.dispose();
  const invalid = { storage: "opfs", whenBusy: "takeover" };
  assert.throws(
    () => createRuntime({ filesystem: invalid as never }),
    /only supports whenBusy: "wait"/,
  );
});
