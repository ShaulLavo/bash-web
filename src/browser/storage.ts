import type { Runtime, SharedFilesystemState, SharedFilesystemStateObserver } from "waffle";

type Listener = (state: SharedFilesystemState) => void;
type Observation = {
  listeners: Set<Listener>;
  previous: SharedFilesystemStateObserver | undefined;
  observer: SharedFilesystemStateObserver;
};
const observations = new WeakMap<Runtime, Observation>();

function observeStorage(runtime: Runtime, listener: Listener): () => void {
  const filesystem = runtime.filesystem;
  let observation = observations.get(runtime);
  if (!observation) {
    const listeners = new Set<Listener>();
    const previous = filesystem.onStateChange;
    const observer: SharedFilesystemStateObserver = (state) => {
      // A listener may detach itself or start another wait during notification.
      for (const receive of Array.from(listeners)) receive(state);
      return previous?.(state);
    };
    observation = { listeners, previous, observer };
    filesystem.onStateChange = observer;
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

/** Storage ownership/recovery is not shell startup and may wait for another tab indefinitely. */
export function waitForStorage(
  runtime: Runtime,
  signal: AbortSignal,
  onState?: Listener,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unobserve = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      unobserve();
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () => finish(signal.reason);
    const receive = (state: SharedFilesystemState) => {
      if (settled) return;
      try {
        onState?.(state);
      } catch (error) {
        finish(error);
        return;
      }
      if (state.status === "ready") finish();
      else if (state.status === "failed")
        finish(state.error ?? new Error("Browser storage could not be opened."));
      else if (state.status === "disposed") finish(new Error("Browser storage was disposed."));
    };
    if (signal.aborted) {
      finish(signal.reason);
      return;
    }
    if (runtime.disposed) {
      finish(new Error("Runtime is disposed"));
      return;
    }
    unobserve = observeStorage(runtime, receive);
    signal.addEventListener("abort", abort, { once: true });
    receive(runtime.filesystem.state);
  });
}
