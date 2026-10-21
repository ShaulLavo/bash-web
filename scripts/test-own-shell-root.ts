import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { fixture } from "./own-shell-runner-fixture.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";
import type { Runtime } from "waffle";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";

const waffle = (await import(
  new URL("../.build/node/api.mjs", import.meta.url).href
)) as typeof Api;

type ProcessService = Awaited<ReturnType<Runtime["processes"]>>;
type Supervisor = Awaited<ReturnType<ProcessService["ready"]>>;

function createRootRuntime() {
  return waffle.createRuntime({
    filesystem: {
      workerURL: new URL("../.build/node/fs.mjs", import.meta.url),
      mode: "memory",
    },
  });
}

async function runFixture(runtime: Runtime, output: Buffer[]) {
  return runRoot(
    runtime,
    waffle,
    await WebAssembly.compile(fixture(2)),
    { modulePath: "", tmp: "/", env: {}, fixtureDirectory: "" },
    "fixture",
    (_fd, bytes) => output.push(Buffer.from(bytes)),
    () => {},
  );
}

function rootWorker(OriginalWorker: typeof Worker, configure: (worker: Worker) => void) {
  return class extends OriginalWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (String(url).endsWith("/root.mjs")) configure(this);
    }
  };
}

function queueRootMessages(worker: Worker, supervisor: Supervisor, beforeDelivery: () => void) {
  const queued: MessageEvent<RuntimeWorkerMessage>[] = [];
  let handler: ((event: MessageEvent<RuntimeWorkerMessage>) => void) | null = null;
  const deliver = async (event: MessageEvent<RuntimeWorkerMessage>) => {
    queued.push(event);
    if (event.data.type !== "exit") return;
    const root = Array.from(supervisor.table.values()).find((record) => record.parentPid === 0);
    assert.ok(root);
    assert.equal(waffle.readOutcome(root.outcome)?.code, 7);
    supervisor.exit(root.pid, 7);
    await setImmediate();
    beforeDelivery();
    for (const message of queued) handler?.(message);
  };
  Object.defineProperty(worker, "onmessage", {
    get: () => deliver,
    set: (listener: typeof handler) => {
      handler = listener;
    },
  });
}

function killRootOnStart(worker: Worker, service: ProcessService, supervisor: Supervisor) {
  worker.postMessage = () => {
    const root = Array.from(supervisor.table.values()).find((record) => record.parentPid === 0);
    assert.ok(root);
    void service.kill(root.pid, 9);
  };
}

test("root completion waits for queued output before acknowledging ordinary exit", async () => {
  installNodeWorkers();
  const OriginalWorker = globalThis.Worker;
  const runtime = createRootRuntime();
  let unobserve = () => {};
  try {
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const output: Buffer[] = [];
    let observedBeforeDelivery = false;
    let rootExitObserved = false;
    unobserve = supervisor.onChildExit(() => {
      rootExitObserved = true;
    });
    const QueuedRootWorker = rootWorker(OriginalWorker, (worker) =>
      queueRootMessages(worker, supervisor, () => (observedBeforeDelivery = rootExitObserved)),
    );
    Object.defineProperty(globalThis, "Worker", { value: QueuedRootWorker, configurable: true });
    const status = await runFixture(runtime, output);
    assert.equal(status, 7);
    assert.equal(
      observedBeforeDelivery,
      false,
      "ordinary completion outran its ordered acknowledgement",
    );
    assert.deepEqual(Buffer.concat(output), Buffer.from([255, 0, 101, 114, 114]));
    assert.equal(rootExitObserved, true);
  } finally {
    unobserve();
    Object.defineProperty(globalThis, "Worker", { value: OriginalWorker, configurable: true });
    await runtime.dispose();
    await stopNodeWorkers();
  }
});

test("a signaled root settles without an ordinary worker acknowledgement", async () => {
  installNodeWorkers();
  const OriginalWorker = globalThis.Worker;
  const runtime = createRootRuntime();
  try {
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const UnstartedRootWorker = rootWorker(OriginalWorker, (worker) =>
      killRootOnStart(worker, service, supervisor),
    );
    Object.defineProperty(globalThis, "Worker", { value: UnstartedRootWorker, configurable: true });
    const output: Buffer[] = [];
    const status = await runFixture(runtime, output);
    assert.equal(status, 137);
    assert.equal(output.length, 0);
  } finally {
    Object.defineProperty(globalThis, "Worker", { value: OriginalWorker, configurable: true });
    await runtime.dispose();
    await stopNodeWorkers();
  }
});
