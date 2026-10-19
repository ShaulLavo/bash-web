import assert from "node:assert/strict";
import { test } from "node:test";
import { pipelinePeak, type ProcessRoot } from "./helpers/pipeline-peak.ts";
import { runtimePipeOptions } from "../src/runtime/limits.ts";

function root(records: ProcessRoot["records"], retainedSlots = records.length): ProcessRoot {
  return {
    pid: 1,
    worker: "Worker",
    directoryBytes: 0,
    memoryBytes: 0,
    droppedTerminalBytes: 0,
    workers: 0,
    processes: records.length,
    liveProcesses: records.length,
    liveJobs: records.length,
    retainedSlots,
    pipes: 0,
    pipeCapacity: runtimePipeOptions.capacity,
    pipeMaxReaders: runtimePipeOptions.maxReaders,
    pipeMaxWriters: runtimePipeOptions.maxWriters,
    guests: [],
    records,
  };
}

function observations() {
  const baseline = root([{ pid: 1, parentPid: 0, job: 1, state: "running", result: null }]);
  const reserved = root(
    baseline.records.concat([{ pid: 2, parentPid: 1, job: 2, state: "starting", result: null }]),
    3,
  );
  const admitted = root(
    reserved.records.concat([{ pid: 3, parentPid: 1, job: 3, state: "starting", result: null }]),
  );
  return { baseline, reserved, admitted };
}

test("pipeline peak keeps complete identities at the slot high-water mark", () => {
  const { baseline, reserved, admitted } = observations();
  const peak = [reserved, admitted, reserved, baseline].reduce(pipelinePeak, baseline);
  assert.equal(peak, admitted);
  assert.equal(peak.retainedSlots, 3);
  assert.deepEqual(
    peak.records.map(({ pid, parentPid, job }) => ({ pid, parentPid, job })),
    [
      { pid: 1, parentPid: 0, job: 1 },
      { pid: 2, parentPid: 1, job: 2 },
      { pid: 3, parentPid: 1, job: 3 },
    ],
  );
});

test("an extra reserved slot cannot be hidden by a more complete lower peak", () => {
  const { baseline, reserved, admitted } = observations();
  const extra = { ...reserved, retainedSlots: 4 };
  const peak = [admitted, extra, admitted, baseline].reduce(pipelinePeak, baseline);
  assert.equal(peak, extra);
  assert.equal(peak.retainedSlots, 4);
});
