// Original integration probe for the exact typed outcomes consumed by shell-runtime's ABI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DescriptorTable } from "waffle/core/descriptors";
import type { FileSystem } from "waffle/core/filesystem";
import { ProcessABI } from "waffle/proc/abi";
import { claimOutcome } from "waffle/proc/outcome";
import { controlStore } from "waffle/proc/control";
import {
  confirmWorkerProcessJob,
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
} from "waffle/proc/worker-client";

for (const [errno, status] of [
  [2, 127],
  [13, 126],
] as const)
  test(`child startup errno ${errno} reaches shell wait and job wait as ${status}`, () => {
    const transport = createWorkerProcessTransport({ capacity: 4 });
    const descriptors = new DescriptorTable();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const unused = (): never => {
      throw new Error("No descriptor transfers in status probe");
    };
    const service = new WorkerProcessClient({
      transport,
      descriptors,
      codec: { export: unused, import: unused, discard: unused },
      postMessage(message) {
        if (message.operation !== "spawn") return;
        const state = workerProcessState(message.transport);
        claimOutcome(state.signals.outcome, { kind: "start-failed", code: errno });
        controlStore(state.confirmed, 0, 1);
        confirmWorkerProcessJob(message.transport);
      },
    });
    const abi = new ProcessABI({
      memory,
      descriptors,
      // The wait imports never touch the filesystem.
      fs: {} as FileSystem,
      pid: service.pid,
      service,
      signals: service.signals,
      wake: service.wake,
    });
    const request = new TextEncoder().encode(
      JSON.stringify({
        executable: "/bin/test-guest",
        argv: ["test-guest"],
        cwd: "/home/guest",
        env: { PATH: "/bin" },
        job: 0,
        fds: [],
      }),
    );
    new Uint8Array(memory.buffer, 64, request.length).set(request);
    const pid = abi.imports.spawn!(64, request.length);
    assert.ok(pid > service.pid);
    const job = abi.imports.job_of!(pid);
    assert.equal(abi.imports.wait!(pid, 0), 0);
    const result = new DataView(memory.buffer);
    assert.equal(result.getUint32(0, true), 0, "startup failure is not a signal");
    assert.equal(result.getInt32(4, true), status);
    assert.equal(abi.imports.wait!(pid, 0), -12, "child outcome is consumed once");
    assert.equal(abi.imports.wait_job!(job, 1, 8), 0);
    assert.equal(result.getInt32(8, true), status);
    assert.equal(abi.imports.wait_job!(job, 1, 8), -12, "job outcome is consumed once");
    descriptors.dispose();
  });
