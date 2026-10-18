// Original adapter telemetry. These are borrowed observations, not a second process service.
import type { Runtime, RuntimeSupervisor } from "waffle";
import {
  attachPipeController,
  type PipeController,
  type PipeEndpointHandle,
} from "waffle/proc/pipes";
import {
  workerProcessSlots,
  workerProcessState,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { processDirectoryCapacity, runtimePipeOptions } from "./limits";

interface RootObservation {
  transport: WorkerProcessTransport;
  memory: SharedArrayBuffer;
  stopped: boolean;
  droppedTerminalBytes: number;
  pipes: Map<string, PipeController>;
  pipeSweep?: ReturnType<typeof setTimeout>;
}
interface Observations {
  roots: Map<number, RootObservation>;
  guests: Map<number, { memory?: SharedArrayBuffer }>;
  supervisor?: RuntimeSupervisor;
  droppedTerminalBytes: number;
}
const observations = new WeakMap<Runtime, Observations>();
function forRuntime(runtime: Runtime): Observations {
  let value = observations.get(runtime);
  if (!value)
    observations.set(
      runtime,
      (value = { roots: new Map(), guests: new Map(), droppedTerminalBytes: 0 }),
    );
  return value;
}
export function observeSupervisor(runtime: Runtime, supervisor: RuntimeSupervisor): void {
  forRuntime(runtime).supervisor = supervisor;
}
export function observeRoot(
  runtime: Runtime,
  transport: WorkerProcessTransport,
  memory: SharedArrayBuffer,
) {
  const state = workerProcessState(transport);
  const root: RootObservation = {
    transport,
    memory,
    stopped: false,
    droppedTerminalBytes: 0,
    pipes: new Map(),
  };
  const observed = forRuntime(runtime);
  observed.roots.set(state.pid, root);
  return {
    stopped() {
      root.stopped = true;
    },
    dropped(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
      root.droppedTerminalBytes += bytes;
      observed.droppedTerminalBytes += bytes;
    },
    retired() {
      clearTimeout(root.pipeSweep);
      root.pipeSweep = undefined;
      root.pipes.clear();
      forRuntime(runtime).roots.delete(state.pid);
    },
  };
}
export function observeGuest(
  runtime: Runtime,
  pid: number,
  memory?: SharedArrayBuffer,
): () => void {
  forRuntime(runtime).guests.set(pid, { memory });
  return () => {
    forRuntime(runtime).guests.delete(pid);
  };
}
function sweepPipes(root: RootObservation): void {
  if (root.pipeSweep !== undefined || root.pipes.size === 0) return;
  // Manual controllers expose only a polled `closed` getter: Waffle's onClosed fires
  // from relay/dispose, neither of which this borrowed observation may own. Observe
  // closure on a bounded cadence instead of retaining ring SABs until a snapshot; this
  // timer never pumps, revokes or disposes a pipe.
  root.pipeSweep = setTimeout(() => {
    root.pipeSweep = undefined;
    for (const [id, pipe] of root.pipes) if (pipe.closed) root.pipes.delete(id);
    sweepPipes(root);
  }, 100);
  // Diagnostics alone must not keep a Node embedding alive; browsers return a number.
  if (typeof root.pipeSweep === "object") root.pipeSweep.unref?.();
}
export function observeProcessMessage(runtime: Runtime, message: WorkerProcessMessage): void {
  if (message.operation !== "pipe") return;
  const handle = message.handle as PipeEndpointHandle;
  for (const root of forRuntime(runtime).roots.values()) {
    // SAB wrappers can differ after structured clone; process identities do not.
    if (
      !workerProcessSlots(root.transport).some(
        (slot) =>
          workerProcessState(root.transport, slot).pid ===
          workerProcessState(message.transport).pid,
      )
    )
      continue;
    if (!root.pipes.has(handle.id)) {
      // Manual attachment never pumps, claims a relay, retains an endpoint or disposes
      // the pipe. The page runtime remains its only relay/disposal owner.
      root.pipes.set(handle.id, attachPipeController(handle, { relay: "manual" }));
      sweepPipes(root);
    }
  }
}
function memoryBytes(memory?: SharedArrayBuffer): number {
  return memory ? Number(Atomics.load(new BigInt64Array(memory), 0)) : 0;
}
/** Metadata-only snapshot for embeddings and tests. No filesystem or supervisor is created. */
export function runtimeSnapshot(runtime: Runtime) {
  const observed = forRuntime(runtime);
  const records = runtime.disposed ? [] : Array.from(observed.supervisor?.table.values() ?? []);
  return {
    filesystemWorkers: runtime.disposed ? 0 : 1,
    droppedTerminalBytes: observed.droppedTerminalBytes,
    processDirectoryCapacity,
    roots: runtime.disposed
      ? []
      : Array.from(observed.roots, ([pid, root]) => {
          const slots = workerProcessSlots(root.transport);
          const identities = new Set(
            slots.map((slot) => workerProcessState(root.transport, slot).pid),
          );
          const own = records.filter((record) => identities.has(record.pid));
          const live = own.filter((record) => !record.result);
          // Keep an immediate snapshot exact; the autonomous sweep owns reclamation.
          for (const [id, pipe] of root.pipes) if (pipe.closed) root.pipes.delete(id);
          return {
            pid,
            worker: "Worker",
            directoryBytes: root.transport.directory.byteLength,
            memoryBytes: memoryBytes(root.memory),
            droppedTerminalBytes: root.droppedTerminalBytes,
            workers: Array.from(observed.guests.keys()).filter((guest) => identities.has(guest))
              .length,
            processes: own.length,
            liveProcesses: live.length,
            liveJobs: new Set(live.map((record) => record.job)).size,
            retainedSlots: slots.length,
            // Root-message observations only, not a descendant-wide pipe census.
            pipes: root.pipes.size,
            pipeCapacity: runtimePipeOptions.capacity,
            pipeMaxReaders: runtimePipeOptions.maxReaders,
            pipeMaxWriters: runtimePipeOptions.maxWriters,
            guests: Array.from(observed.guests, ([guest, info]) => ({
              pid: guest,
              memoryBytes: memoryBytes(info.memory),
            })).filter((guest) => identities.has(guest.pid)),
            records: own.map((record) => ({
              pid: record.pid,
              parentPid: record.parentPid,
              job: record.job,
              state: record.state,
              result: record.result,
            })),
          };
        }),
  };
}
