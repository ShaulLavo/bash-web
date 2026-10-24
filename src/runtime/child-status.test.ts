// Original integration probe for the exact typed outcomes consumed by shell-runtime's ABI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DescriptorTable } from "waffle/core/descriptors";
import type { FileSystem } from "waffle/core/filesystem";
import { ProcessABI } from "waffle/proc/abi";
import { claimOutcome } from "waffle/proc/outcome";
import { controlStore } from "waffle/proc/control";
import type { ProcessExit } from "waffle/proc/types";
import {
  confirmWorkerProcessJob,
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
} from "waffle/proc/worker-client";

const outcomes: {
  name: string;
  outcome: Pick<ProcessExit, "kind" | "code">;
  kind: number;
  value: number;
}[] = [
  { name: "ENOENT", outcome: { kind: "start-failed", code: 2 }, kind: 2, value: 44 },
  { name: "EACCES", outcome: { kind: "start-failed", code: 13 }, kind: 2, value: 2 },
  { name: "ENOTDIR", outcome: { kind: "start-failed", code: 20 }, kind: 2, value: 54 },
  { name: "ENOEXEC", outcome: { kind: "start-failed", code: 8 }, kind: 2, value: 45 },
  { name: "ENOMEM", outcome: { kind: "start-failed", code: 12 }, kind: 2, value: 48 },
  { name: "EAGAIN", outcome: { kind: "start-failed", code: 11 }, kind: 2, value: 6 },
  { name: "EIO", outcome: { kind: "start-failed", code: 5 }, kind: 2, value: 29 },
  { name: "real exit 126", outcome: { kind: "exited", code: 126 }, kind: 0, value: 126 },
  { name: "real exit 127", outcome: { kind: "exited", code: 127 }, kind: 0, value: 127 },
  { name: "signal 9", outcome: { kind: "signaled", code: 9 }, kind: 1, value: 9 },
];

for (const { name, outcome, kind, value } of outcomes)
  test(`${name} reaches both waits as an eight-byte typed record`, () => {
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
        claimOutcome(state.signals.outcome, outcome);
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
    try {
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
      const bytes = new Uint8Array(memory.buffer, 0, 40);
      bytes.fill(0xa5);
      const fault = memory.buffer.byteLength - 4;
      assert.equal(abi.imports.wait!(pid, fault), -21, "all eight bytes must fit before consuming");
      assert.equal(abi.imports.wait!(pid, 8), 0);
      const result = new DataView(memory.buffer);
      assert.equal(result.getUint32(8, true), kind);
      assert.equal(result.getInt32(12, true), value);
      assert.equal(abi.imports.wait!(pid, 8), -12, "child outcome is consumed once");
      assert.equal(abi.imports.wait_job!(job, 1, fault), -21);
      assert.equal(abi.imports.wait_job!(job, 1, 24), 0);
      assert.equal(result.getUint32(24, true), kind);
      assert.equal(result.getInt32(28, true), value);
      assert.equal(abi.imports.wait_job!(job, 1, 24), -12, "job outcome is consumed once");
      for (const offset of [0, 16, 32])
        assert.ok(bytes.subarray(offset, offset + 8).every((byte) => byte === 0xa5));
    } finally {
      descriptors.dispose();
    }
  });
