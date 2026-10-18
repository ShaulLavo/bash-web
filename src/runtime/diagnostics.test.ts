// Original telemetry lifecycle regressions. Diagnostics borrow pipe state without owning it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "waffle";
import { PipeController } from "waffle/proc/pipes";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { observeProcessMessage, observeRoot, runtimeSnapshot } from "./diagnostics";

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
