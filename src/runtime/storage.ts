import type { Runtime, SharedFilesystemState, SharedFilesystemStateObserver } from "waffle";
import { markStartup, type StartupObserver } from "./startup-diagnostics.ts";

type Listener = (state: SharedFilesystemState) => void;
type Observation = {
  listeners: Set<Listener>;
  previous: SharedFilesystemStateObserver | undefined;
  observer: SharedFilesystemStateObserver;
};
const observations = new WeakMap<Runtime, Observation>();

/** Separate from the shell guard; opening and active recovery each have their own budget. */
export const STORAGE_READY_TIMEOUT_MS = 60000;

/** Attach before runtime creation so a fast lock grant cannot precede its consumer's wait. */
export function createStorageStartup() {
  let acquiredAt: number | undefined;
  const listeners = new Set<(at: number) => void>();
  const observe: StartupObserver = (stage) => {
    if (stage !== "filesystem-lock-acquired" || acquiredAt !== undefined) return;
    // Budget from receipt in this realm, not a worker clock or the duration of a queued wait.
    acquiredAt = performance.now();
    for (const listener of Array.from(listeners)) listener(acquiredAt);
  };
  return {
    observe,
    onLockAcquired(listener: (at: number) => void): () => void {
      listeners.add(listener);
      if (acquiredAt !== undefined) listener(acquiredAt);
      return () => listeners.delete(listener);
    },
  };
}
export type StorageStartup = ReturnType<typeof createStorageStartup>;

type StorageWaitOptions = {
  onState?: Listener;
  onStartupStage?: StartupObserver;
  startup?: StorageStartup;
};

function createObservation(runtime: Runtime): Observation {
  const listeners = new Set<Listener>();
  const previous = runtime.filesystem.onStateChange;
  const observer: SharedFilesystemStateObserver = (state) => {
    // A listener may detach itself or start another wait during notification.
    for (const receive of Array.from(listeners)) receive(state);
    return previous?.(state);
  };
  runtime.filesystem.onStateChange = observer;
  return { listeners, previous, observer };
}

function observeStorage(runtime: Runtime, listener: Listener): () => void {
  const filesystem = runtime.filesystem;
  let observation = observations.get(runtime);
  if (!observation) {
    observation = createObservation(runtime);
    observations.set(runtime, observation);
  }
  const current = observation;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size) return;
    // Runtime disposal revokes callback setters too. Its disposed filesystem no longer
    // emits transitions, so there is nothing to detach on that path.
    if (!runtime.disposed && filesystem.onStateChange === current.observer)
      filesystem.onStateChange = current.previous;
    if (observations.get(runtime) === current) observations.delete(runtime);
  };
}

function startStorageWait(
  runtime: Runtime,
  signal: AbortSignal,
  options: StorageWaitOptions,
  resolve: () => void,
  reject: (error: unknown) => void,
): void {
  let settled = false;
  let waitedForOwnership = false;
  let recovering = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unobserve = () => {};
  let unobserveLock = () => {};
  const clearGuard = () => {
    clearTimeout(timeout);
    timeout = undefined;
  };
  const finish = (...failure: [] | [unknown]) => {
    if (settled) return;
    settled = true;
    clearGuard();
    signal.removeEventListener("abort", abort);
    unobserve();
    unobserveLock();
    if (failure.length) return reject(failure[0]);
    markStartup(options.onStartupStage, "storage-wait-resolved");
    resolve();
  };
  const abort = () => finish(signal.reason);
  const acquired = (at: number) => {
    if (settled || recovering || !waitedForOwnership) return;
    recovering = true;
    clearGuard();
    timeout = setTimeout(
      () => finish(new Error("Browser storage recovery did not finish within 60 seconds.")),
      Math.max(0, STORAGE_READY_TIMEOUT_MS - (performance.now() - at)),
    );
  };
  const receive = (state: SharedFilesystemState) => {
    if (settled) return;
    // Waffle stays typed waiting during recovery; only the actual grant starts that budget.
    if (state.status === "waiting" && !recovering) {
      waitedForOwnership = true;
      clearGuard();
    }
    try {
      options.onState?.(state);
    } catch (error) {
      finish(error);
      return;
    }
    if (state.status === "ready") finish();
    else if (state.status === "failed")
      finish(state.error ?? new Error("Browser storage could not be opened."));
    else if (state.status === "disposed") finish(new Error("Browser storage was disposed."));
  };
  markStartup(options.onStartupStage, "storage-wait-requested");
  if (signal.aborted) return finish(signal.reason);
  if (runtime.disposed) return finish(new Error("Runtime is disposed"));
  unobserve = observeStorage(runtime, receive);
  signal.addEventListener("abort", abort, { once: true });
  const initial = runtime.filesystem.state;
  if (initial.status === "opening") {
    timeout = setTimeout(
      () => finish(new Error("Browser storage did not become ready within 60 seconds.")),
      STORAGE_READY_TIMEOUT_MS,
    );
  }
  receive(initial);
  if (!settled && options.startup) unobserveLock = options.startup.onLockAcquired(acquired);
}

/** Genuine pre-lock ownership waiting is indefinite; active recovery is not shell startup. */
export function waitForStorage(
  runtime: Runtime,
  signal: AbortSignal,
  options: StorageWaitOptions = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    startStorageWait(runtime, signal, options, resolve, reject),
  );
}
