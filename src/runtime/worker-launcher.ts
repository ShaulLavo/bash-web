// Original shared-terminal policy, adapted from brush-web src/runtime/browser-runtime.ts
// and src/runtime/subprocess-broker.ts at a2a4e96. Waffle owns worker launch, admission,
// descriptor transport, outcomes and supervision; the shell only fences its terminal ring.
import type { ProcessService, Runtime } from "waffle";
import type { WorkerLaunchOptions } from "waffle/browser/process-broker";
import type { RuntimeWorkerRequest } from "waffle/browser/worker";
import type { FilesystemIdentity } from "waffle/fs";
import type { ProcessContext, ProcessHandle } from "waffle/proc/types";
import { workerProcessDirectoryId, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { observeGuest } from "./diagnostics";
import {
  attachTerminal,
  createTerminalAdmission,
  quiesceTerminal,
  revokeTerminal,
  type TerminalAdmission,
} from "./terminal-admission";

export interface ShellWorkerData {
  filesystem: FilesystemIdentity;
  shellTerminal?: SharedArrayBuffer;
  terminalAdmission?: TerminalAdmission;
}

// Completion observations only: Waffle still owns launch, fences and physical stops.
const pendingCleanup = new WeakMap<Runtime, Map<string, Set<Promise<void>>>>();
function observeCleanup(runtime: Runtime, transport: WorkerProcessTransport): () => void {
  let directories = pendingCleanup.get(runtime);
  if (!directories) pendingCleanup.set(runtime, (directories = new Map()));
  const id = workerProcessDirectoryId(transport);
  let pending = directories.get(id);
  if (!pending) directories.set(id, (pending = new Set()));
  const owners = directories;
  const completions = pending;
  let resolve!: () => void;
  const completed = new Promise<void>((done) => {
    resolve = done;
  });
  completions.add(completed);
  return () => {
    completions.delete(completed);
    if (!completions.size && owners.get(id) === completions) owners.delete(id);
    resolve();
  };
}
/** Joins only this package's observed workers, not foreign adapters or other shell roots. */
export async function waitForShellWorkers(
  runtime: Runtime,
  transport: WorkerProcessTransport,
): Promise<void> {
  const id = workerProcessDirectoryId(transport);
  for (;;) {
    const pending = pendingCleanup.get(runtime)?.get(id);
    if (!pending?.size) return;
    await Promise.all(Array.from(pending));
  }
}

/** No worker or process service is created here. The accepted adapter consumer remains
 * fenced by the page runtime until its broker has physically stopped this guest. */
export function launchTerminalWorker<T extends RuntimeWorkerRequest>(
  runtime: Runtime,
  service: ProcessService,
  context: ProcessContext,
  options: WorkerLaunchOptions<T>,
): ProcessHandle {
  const transport = service.transportFor(context.pid);
  if (!transport) throw new Error("Process has no admitted worker transport");
  const data = transport.data as ShellWorkerData;
  if (!data?.filesystem) throw new TypeError("Process has no filesystem identity");
  const admission = data.terminalAdmission ?? createTerminalAdmission();
  if (data.shellTerminal) attachTerminal(admission, data.shellTerminal);
  transport.data = { ...data, terminalAdmission: admission };
  let handle: ProcessHandle | undefined;
  let release = () => {};
  const memory =
    "memoryUsage" in options.request && options.request.memoryUsage instanceof SharedArrayBuffer
      ? options.request.memoryUsage
      : undefined;
  const forget = observeGuest(runtime, context.pid, memory);
  const completed = observeCleanup(runtime, transport);
  let cleaned = false;
  let accepted = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    forget();
    try {
      options.cleanup?.();
    } finally {
      try {
        release();
      } finally {
        completed();
      }
    }
  };
  const revoke = () => {
    revokeTerminal(admission);
    options.wake?.();
  };
  const stop = async () => {
    await quiesceTerminal(admission);
    await handle?.terminate();
  };
  let fence: Promise<void> | undefined;
  // The broker joins this adapter fence with its own filesystem fence on every
  // finalization path. It is also callable during Runtime.dispose, without using
  // any borrowed capability after the page owner has closed admission.
  const quiesce = () => (fence ??= quiesceTerminal(admission).then(() => {}));
  try {
    release = runtime.retainConsumer({ filesystem: data.filesystem, revoke, stop });
    service.registerController(context.pid, {
      filesystem: data.filesystem,
      revoke,
      quiesce,
      stop,
      // The waiting shell owns the errno diagnostic and its redirected fd2 lifetime.
      // Suppress only Waffle's generic startup message, not guest I/O or execution errors.
      startFailed() {},
      retired: cleanup,
    });
    accepted = true;
    handle = service.launchWorker(context, { ...options, cleanup });
    return handle;
  } catch (error) {
    // No local worker ownership exists. An accepted broker controller and retained
    // consumer continue to own the failure fence even if launchWorker threw.
    if (!accepted) cleanup();
    throw error;
  }
}
