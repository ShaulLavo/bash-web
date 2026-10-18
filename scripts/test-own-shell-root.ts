import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { fixture } from "./own-shell-runner-fixture.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";

const waffle = (await import(
  new URL("../.build/node/api.mjs", import.meta.url).href
)) as typeof Api;

test("root completion waits for queued output before acknowledging ordinary exit", async () => {
  installNodeWorkers();
  const OriginalWorker = globalThis.Worker;
  const runtime = waffle.createRuntime({
    filesystem: {
      workerURL: new URL("../.build/node/fs.mjs", import.meta.url),
      persistence: false,
    },
  });
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
    class QueuedRootWorker extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).endsWith("/root.mjs")) return;
        const queued: MessageEvent<RuntimeWorkerMessage>[] = [];
        let handler: ((event: MessageEvent<RuntimeWorkerMessage>) => void) | null = null;
        const deliver = async (event: MessageEvent<RuntimeWorkerMessage>) => {
          queued.push(event);
          if (event.data.type !== "exit") return;
          const root = Array.from(supervisor.table.values()).find(
            (record) => record.parentPid === 0,
          );
          assert.ok(root);
          assert.equal(waffle.readOutcome(root.outcome)?.code, 7);
          supervisor.exit(root.pid, 7);
          await setImmediate();
          observedBeforeDelivery = rootExitObserved;
          for (const message of queued) handler?.(message);
        };
        Object.defineProperty(this, "onmessage", {
          get: () => deliver,
          set: (listener: typeof handler) => {
            handler = listener;
          },
        });
      }
    }
    Object.defineProperty(globalThis, "Worker", { value: QueuedRootWorker, configurable: true });
    const status = await runRoot(
      runtime,
      waffle,
      await WebAssembly.compile(fixture(2)),
      { modulePath: "", tmp: "/", env: {}, fixtureDirectory: "" },
      "fixture",
      (_fd, bytes) => output.push(Buffer.from(bytes)),
      () => {},
    );
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
  const runtime = waffle.createRuntime({
    filesystem: {
      workerURL: new URL("../.build/node/fs.mjs", import.meta.url),
      persistence: false,
    },
  });
  try {
    const service = await runtime.processes();
    const supervisor = await service.ready();
    class UnstartedRootWorker extends OriginalWorker {
      postMessage() {
        const root = Array.from(supervisor.table.values()).find((record) => record.parentPid === 0);
        assert.ok(root);
        void service.kill(root.pid, 9);
      }
    }
    Object.defineProperty(globalThis, "Worker", { value: UnstartedRootWorker, configurable: true });
    const output: Buffer[] = [];
    const status = await runRoot(
      runtime,
      waffle,
      await WebAssembly.compile(fixture(2)),
      { modulePath: "", tmp: "/", env: {}, fixtureDirectory: "" },
      "fixture",
      (_fd, bytes) => output.push(Buffer.from(bytes)),
      () => {},
    );
    assert.equal(status, 137);
    assert.equal(output.length, 0);
  } finally {
    Object.defineProperty(globalThis, "Worker", { value: OriginalWorker, configurable: true });
    await runtime.dispose();
    await stopNodeWorkers();
  }
});
