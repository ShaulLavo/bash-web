import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharedControlAllocator } from "waffle";
import type { RuntimeWorkerRequest } from "waffle/browser/worker";
import {
  createWorkerProcessTransport,
  workerProcessState,
  workerProcessSlots,
} from "waffle/proc/worker-client";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { waitStatus } from "waffle/proc/wait-status";
import { runRoot } from "../scripts/waffle-compat";
import { createFixtureRuntime } from "./helpers/runtime-owner";

test("compatibility root carries minted control ownership through actual stop", async (context) => {
  const runtime = createFixtureRuntime(context);
  const service = await runtime.processes();
  const previousWorker = globalThis.Worker;
  const stop = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<RuntimeWorkerRequest>();
  const stopping = Promise.withResolvers<void>();
  let terminated = 0;
  globalThis.Worker = class extends EventTarget implements Worker {
    onerror: Worker["onerror"] = null;
    onmessage: Worker["onmessage"] = null;
    onmessageerror: Worker["onmessageerror"] = null;
    postMessage(value: RuntimeWorkerRequest) {
      posted.resolve(value);
      queueMicrotask(() => {
        this.onmessage?.(new MessageEvent("message", { data: { type: "exit", code: 7 } }));
      });
    }
    terminate() {
      terminated++;
      stopping.resolve();
      return stop.promise;
    }
  };
  context.after(async () => {
    stop.resolve();
    await runtime.dispose();
    globalThis.Worker = previousWorker;
  });
  const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const running = runRoot(
    runtime,
    {
      createWorkerProcessTransport,
      workerProcessState,
      workerProcessSlots,
      claimOutcome,
      readOutcome,
      waitStatus,
    },
    { module, memory: [] },
    { modulePath: "", tmp: "/", env: {}, fixtureDirectory: "" },
    "",
    () => {},
    () => {},
  );
  const request = await posted.promise;
  assert.ok(request.runtimeProcess);
  const pid = request.runtimeProcess.pid;
  const allocate = createSharedControlAllocator(request.controlGrant, (buffer) =>
    service.rootControlAllocated(pid, buffer),
  );
  assert.equal(allocate(8).byteLength, 8);
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await stopping.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(terminated, 1);
  assert.equal(settled, false, "logical completion must join actual termination");
  stop.resolve();
  assert.equal(await running, 7);
  assert.throws(() => service.rootControlGrant(pid), /grant|root/i);
});
