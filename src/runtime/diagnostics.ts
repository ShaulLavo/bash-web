// Original adapter telemetry. These are borrowed observations, not a second process service.
import type { ProcessService, Runtime, RuntimeSupervisor } from "waffle";
import { ProcessErrno, ProcessError } from "waffle/proc/types";
import {
  attachPipeController,
  type PipeController,
  type PipeEndpointHandle,
} from "waffle/proc/pipes";
import {
  workerProcessDirectoryId,
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
  processes?: ProcessService;
  supervisor?: RuntimeSupervisor;
  droppedTerminalBytes: number;
}
function readProcessState(transport: WorkerProcessTransport, slot?: number) {
  try {
    return workerProcessState(transport, slot);
  } catch (error) {
    // Enumeration borrows rows; a consuming wait can collect the process or its job.
    if (
      error instanceof ProcessError &&
      (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD)
    )
      return;
    throw error;
  }
}
function liveProcessStates(transport: WorkerProcessTransport) {
  return workerProcessSlots(transport).flatMap((slot) => {
    const state = readProcessState(transport, slot);
    return state ? [state] : [];
  });
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
export function observeProcessService(runtime: Runtime, service: ProcessService): void {
  forRuntime(runtime).processes = service;
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
  const sender = readProcessState(message.transport);
  if (!sender) return;
  for (const root of forRuntime(runtime).roots.values()) {
    // SAB wrappers can differ after structured clone; process identities do not.
    if (!liveProcessStates(root.transport).some((state) => state.pid === sender.pid)) continue;
    if (!root.pipes.has(handle.id)) {
      // Manual attachment never pumps, claims a relay, retains an endpoint or disposes
      // the pipe. The page runtime remains its only relay/disposal owner.
      root.pipes.set(handle.id, attachPipeController(handle, { relay: "manual" }));
      sweepPipes(root);
    }
  }
}
function memoryBytes(memory: SharedArrayBuffer): number;
function memoryBytes(memory?: SharedArrayBuffer): number | null;
function memoryBytes(memory?: SharedArrayBuffer): number | null {
  return memory ? Number(Atomics.load(new BigInt64Array(memory), 0)) : null;
}
function rootGuests(
  observed: Observations,
  root: RootObservation,
  rootPid: number,
  identities: ReadonlySet<number>,
) {
  const directory = workerProcessDirectoryId(root.transport);
  const guests = new Map<
    number,
    { memoryBytes: number | null; source: "adapter" | "waffle" | "adapter+waffle" }
  >();
  for (const sample of observed.processes?.workerMemory() ?? []) {
    if (sample.rootPid !== rootPid || sample.directory !== directory) continue;
    guests.set(sample.pid, { memoryBytes: sample.bytes, source: "waffle" });
  }
  for (const [pid, info] of observed.guests) {
    if (!identities.has(pid)) continue;
    const published = guests.get(pid);
    guests.set(pid, {
      memoryBytes: info.memory ? memoryBytes(info.memory) : (published?.memoryBytes ?? null),
      source: published ? "adapter+waffle" : "adapter",
    });
  }
  return Array.from(guests, ([pid, guest]) => ({ pid, ...guest }));
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
          const states = liveProcessStates(root.transport);
          const identities = new Set(states.map((state) => state.pid));
          const own = records.filter((record) => identities.has(record.pid));
          const live = own.filter((record) => !record.result);
          // Keep an immediate snapshot exact; the autonomous sweep owns reclamation.
          for (const [id, pipe] of root.pipes) if (pipe.closed) root.pipes.delete(id);
          const guests = rootGuests(observed, root, pid, identities);
          return {
            pid,
            worker: "Worker",
            directoryBytes: root.transport.directory.byteLength,
            memoryBytes: memoryBytes(root.memory),
            droppedTerminalBytes: root.droppedTerminalBytes,
            workers: guests.length,
            processes: own.length,
            liveProcesses: live.length,
            liveJobs: new Set(live.map((record) => record.job)).size,
            retainedSlots: states.length,
            // Root-message observations only, not a descendant-wide pipe census.
            pipes: root.pipes.size,
            pipeCapacity: runtimePipeOptions.capacity,
            pipeMaxReaders: runtimePipeOptions.maxReaders,
            pipeMaxWriters: runtimePipeOptions.maxWriters,
            guests,
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
