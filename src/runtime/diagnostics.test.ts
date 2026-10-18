// Original telemetry lifecycle regressions. Diagnostics borrow pipe state without owning it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import { claimOutcome } from "waffle/proc/outcome";
import { PipeController } from "waffle/proc/pipes";
import {
  confirmWorkerProcessJob,
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
} from "waffle/proc/worker-client";
import { observeGuest, observeProcessMessage, observeRoot, runtimeSnapshot } from "./diagnostics";

test("snapshot ignores a process collected between enumeration and reading its state", (context) => {
  const runtime = {} as Runtime;
  const transport = createWorkerProcessTransport({ capacity: 8 });
  const descriptors = new DescriptorTable();
  const unused = (): never => {
    throw new Error("No descriptor transfers in snapshot probe");
  };
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage(message) {
      if (message.operation !== "spawn") return;
      claimOutcome(workerProcessState(message.transport).signals.outcome, {
        kind: "exited",
        code: 0,
      });
      confirmWorkerProcessJob(message.transport);
    },
  });
  const child = client.spawn(client.pid, {
    executable: "/bin/probe",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  const observedTransport = {
    ...transport,
    get directory() {
      return transport.directory;
    },
  };
  const observation = observeRoot(runtime, observedTransport, new SharedArrayBuffer(8));
  const retireGuest = observeGuest(runtime, child);
  context.after(() => {
    observation.retired();
    retireGuest();
    descriptors.dispose();
  });
  assert.equal(runtimeSnapshot(runtime).roots[0]!.retainedSlots, 2);
  let reads = 0;
  context.mock.getter(observedTransport, "directory", () => {
    // First read lists both slots. Collect on the next read, before state lookup.
    if (++reads === 2) assert.equal(client.wait(client.pid, child)!.code, 0);
    return transport.directory;
  });
  const root = runtimeSnapshot(runtime).roots[0]!;
  assert.ok(reads >= 2);
  assert.equal(root.pid, client.pid);
  assert.equal(root.retainedSlots, 1);
  assert.equal(root.workers, 0);
  assert.deepEqual(root.guests, []);
});

test("snapshot does not hide invalid process directories", (context) => {
  const runtime = {} as Runtime;
  const transport = createWorkerProcessTransport({ capacity: 8 });
  const observation = observeRoot(runtime, transport, new SharedArrayBuffer(8));
  context.after(() => observation.retired());
  transport.directory = new SharedArrayBuffer(7);
  assert.throws(() => runtimeSnapshot(runtime), TypeError);
});

for (const retire of [false, true]) {
  test(`pipe observations release buffers without snapshot polling (${retire ? "root retired" : "pipe closed"})`, (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const runtime = {} as Runtime;
    const transport = createWorkerProcessTransport({ capacity: 8 });
    const observation = observeRoot(runtime, transport, new SharedArrayBuffer(8));
    const pipe = new PipeController({ capacity: 8, maxReaders: 1, maxWriters: 1, relay: "manual" });
    context.after(() => {
      observation.retired();
      pipe.dispose();
    });
    const pid = workerProcessState(transport).pid;
    const reader = pipe.retain(pid, "read");
    const writer = pipe.retain(pid, "write");
    const getter = Object.getOwnPropertyDescriptor(PipeController.prototype, "closed")!.get!;
    const closed = context.mock.getter(PipeController.prototype, "closed", getter);
    observeProcessMessage(runtime, {
      type: "runtime-proc",
      operation: "pipe",
      transport,
      handle: reader.handle(),
    });
    if (retire) observation.retired();
    else {
      reader.close();
      writer.close();
    }
    // No runtimeSnapshot call occurs until after the closure sweep. Its getter
    // proves closure was observed autonomously, not as a side effect of inspection.
    context.mock.timers.tick(100);
    assert.equal(closed.mock.callCount(), retire ? 0 : 1);
    context.mock.timers.tick(10000);
    assert.equal(
      closed.mock.callCount(),
      retire ? 0 : 1,
      "no timer or controller remains retained",
    );
    const snapshot = runtimeSnapshot(runtime);
    if (retire) assert.equal(snapshot.roots.length, 0);
    else assert.equal(snapshot.roots[0]!.pipes, 0);
  });
}
