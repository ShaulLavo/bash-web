import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRuntime, type Runtime, type SharedFilesystemState } from "waffle";
import type { FilesystemConnection } from "waffle/fs/protocol";
import { FilesystemService } from "waffle/fs/service";
import { MemoryBackend } from "waffle/fs/backend";
import { BrowserSession } from "./session";
import { waitForStorage } from "./storage";

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
      if (message.dispose) this.disposalRequested = true;
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
    // Begin cancellation before acknowledging it, just like the worker-side abort handshake.
    const disposing = runtime?.dispose();
    for (const worker of workers) worker.finishDisposal();
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

test("runtime disposal begins the waiting-storage handshake synchronously and awaits acknowledgement", async (context) => {
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create({ filesystem: { storage: "opfs" } });
  worker.state("waiting");
  const opening = waitForStorage(runtime, new AbortController().signal);
  const rejected = assert.rejects(opening, /storage was disposed/);
  let finished = false;
  const disposing = runtime.dispose().then(() => {
    finished = true;
  });
  assert.equal(worker.disposalRequested, true);
  await rejected;
  await turn();
  assert.equal(finished, false);
  assert.equal(worker.terminated, false);
  worker.finishDisposal();
  await disposing;
  assert.equal(worker.terminated, true);
  assert.equal(runtime.filesystem.state.status, "disposed");
});

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

test("storage defaults are forwarded unchanged and OPFS takeover is rejected", async (context) => {
  const fixture = storageWorker(context);
  const { runtime, worker } = fixture.create();
  assert.deepEqual(worker.initialization, { storage: "indexeddb", whenBusy: undefined });
  // A default IndexedDB runtime has no cancellable ownership wait.
  await runtime.dispose();
  const invalid = { storage: "opfs", whenBusy: "takeover" };
  assert.throws(
    () => createRuntime({ filesystem: invalid as never }),
    /only supports whenBusy: "wait"/,
  );
});
