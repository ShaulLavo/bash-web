import { parentPort, workerData, MessagePort } from "node:worker_threads";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";

interface WorkerBootstrapData {
  entry: string;
  pooled?: boolean;
}

interface AttachControl {
  type: "__attach";
  seq: number;
  port: MessagePort;
}

interface DetachControl {
  type: "__detach";
  seq: number;
}

type ControlMessage = AttachControl | DetachControl;

interface MessageListenerEntry {
  readonly listener: EventListenerOrEventListenerObject;
  readonly once: boolean;
}

type InstallSession = (scope: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
}) => void;

if (!parentPort) throw new Error("Worker thread has no parent port");
const control = parentPort;
const data = workerData as WorkerBootstrapData;

function filterTransfers(transfer: readonly unknown[]): (ArrayBuffer | MessagePort)[] {
  return transfer.filter(
    (value): value is ArrayBuffer | MessagePort =>
      value instanceof ArrayBuffer || value instanceof MessagePort,
  );
}

function serializeError(seq: number, error: unknown) {
  if (error instanceof Error) {
    return {
      type: "__error",
      seq,
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    type: "__error",
    seq,
    name: "Error",
    message: String(error),
  };
}

function removeListener(
  list: MessageListenerEntry[],
  listener: EventListenerOrEventListenerObject,
): void {
  const index = list.findIndex((entry) => entry.listener === listener);
  if (index >= 0) list.splice(index, 1);
}

function invokeListener(
  listener: EventListenerOrEventListenerObject,
  event: MessageEvent,
): unknown {
  if (typeof listener === "function") return listener.call(globalThis, event);
  return listener.handleEvent(event);
}

installNodeWorkers();

if (!data.pooled) {
  const events = new EventTarget();
  Object.defineProperties(globalThis, {
    self: { value: globalThis, configurable: true },
    postMessage: {
      value: (message: unknown, transfer: readonly Transferable[] = []) =>
        control.postMessage(message, filterTransfers(transfer)),
      configurable: true,
    },
    addEventListener: { value: events.addEventListener.bind(events), configurable: true },
    removeEventListener: { value: events.removeEventListener.bind(events), configurable: true },
  });
  let ready = false;
  const queued: unknown[] = [];
  function dispatch(payload: unknown) {
    const event = new MessageEvent("message", { data: payload });
    const listener: unknown = Reflect.get(globalThis, "onmessage");
    if (typeof listener === "function") listener.call(globalThis, event);
    events.dispatchEvent(event);
  }
  control.on("message", (payload) => {
    if (ready) dispatch(payload);
    else queued.push(payload);
  });
  await import(data.entry);
  ready = true;
  for (const payload of queued) dispatch(payload);
  control.on("close", () => {
    void stopNodeWorkers();
  });
} else {
  let activePort: MessagePort | null = null;
  let activeSeq = 0;
  let activeDetach: (() => Promise<boolean>) | null = null;
  let loadedReady = false;
  const importMessageListeners: MessageListenerEntry[] = [];
  let leaseMessageListeners: MessageListenerEntry[] = [];
  let otherEvents = new EventTarget();

  Object.defineProperties(globalThis, {
    __bashWebPooledWorker: { value: true, configurable: true },
    self: { value: globalThis, configurable: true },
    postMessage: {
      value: (message: unknown, transfer: readonly Transferable[] = []) => {
        activePort?.postMessage(message, filterTransfers(transfer));
      },
      configurable: true,
    },
    addEventListener: {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (!listener) return;
        if (type !== "message") {
          otherEvents.addEventListener(type, listener, options);
          return;
        }
        const target = loadedReady ? leaseMessageListeners : importMessageListeners;
        if (target.some((entry) => entry.listener === listener)) return;
        const once =
          typeof options === "object" && options !== null ? Boolean(options.once) : false;
        target.push({ listener, once });
      },
      configurable: true,
    },
    removeEventListener: {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => {
        if (!listener) return;
        if (type !== "message") {
          otherEvents.removeEventListener(type, listener, options);
          return;
        }
        removeListener(leaseMessageListeners, listener);
        removeListener(importMessageListeners, listener);
      },
      configurable: true,
    },
  });

  await import(data.entry);
  const candidate: unknown = Reflect.get(globalThis, "__bashWebInstallSession");
  const installSession =
    typeof candidate === "function" ? (candidate as InstallSession) : undefined;
  const pendingControls: ControlMessage[] = [];

  async function detach(seq: number, notifyHost: boolean): Promise<void> {
    if (activeSeq !== seq || !activePort) return;
    const port = activePort;
    const runDetach = activeDetach;
    activeDetach = null;
    port.removeAllListeners();
    const clean = runDetach ? await runDetach() : true;
    if (activeSeq === seq) {
      activePort = null;
      leaseMessageListeners = [];
      otherEvents = new EventTarget();
    }
    port.close();
    await stopNodeWorkers();
    if (notifyHost && clean && activeSeq === seq && liveNodeWorkers() === 0) {
      control.postMessage({ type: "__settled", seq });
    }
  }

  function attachFilesystem(
    seq: number,
    port: MessagePort,
    install: NonNullable<typeof installSession>,
  ) {
    let detached = false;
    let disposedClean: boolean | null = null;
    let disposeWaiter: ((clean: boolean) => void) | null = null;
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(message: unknown, transfer: readonly unknown[] = []) {
        const record = message as { type?: unknown; error?: unknown } | null;
        if (record?.type === "filesystem-disposed") {
          const clean = typeof record.error !== "string";
          disposedClean = clean;
          const notify = disposeWaiter;
          disposeWaiter = null;
          notify?.(clean);
          if (detached) return;
        }
        if (detached || activeSeq !== seq) return;
        port.postMessage(message, filterTransfers(transfer));
      },
    };
    install(scope);
    activeDetach = () => {
      detached = true;
      if (disposedClean !== null) return Promise.resolve(disposedClean);
      return new Promise<boolean>((resolve) => {
        disposeWaiter = resolve;
        try {
          scope.onmessage?.(new MessageEvent("message", { data: { dispose: true } }));
        } catch (error) {
          disposeWaiter = null;
          control.postMessage(serializeError(seq, error));
          resolve(false);
        }
      });
    };
    port.on("message", (payload) => {
      if (detached || activeSeq !== seq) return;
      try {
        scope.onmessage?.(new MessageEvent("message", { data: payload }));
      } catch (error) {
        control.postMessage(serializeError(seq, error));
      }
    });
  }

  function attachStandard(seq: number, port: MessagePort) {
    let inFlight = 0;
    let errored = false;
    let detaching = false;
    let idleWaiter: (() => void) | null = null;
    const finishOne = () => {
      inFlight -= 1;
      if (inFlight === 0 && idleWaiter) {
        const notify = idleWaiter;
        idleWaiter = null;
        notify();
      }
    };
    const failLease = (error: unknown) => {
      errored = true;
      if (activeSeq === seq) {
        control.postMessage(serializeError(seq, error));
      }
    };
    const runTracked = (invoke: () => unknown) => {
      inFlight += 1;
      let outcome: unknown;
      try {
        outcome = invoke();
      } catch (error) {
        failLease(error);
        finishOne();
        return;
      }
      Promise.resolve(outcome).catch(failLease).finally(finishOne);
    };
    activeDetach = async () => {
      detaching = true;
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          idleWaiter = resolve;
        });
      }
      return !errored;
    };
    port.on("message", (payload) => {
      if (detaching || activeSeq !== seq) return;
      const event = new MessageEvent("message", { data: payload });
      const onmessage: unknown = Reflect.get(globalThis, "onmessage");
      if (typeof onmessage === "function") {
        runTracked(() => onmessage.call(globalThis, event));
      }
      const snapshot = importMessageListeners.concat(leaseMessageListeners);
      for (const entry of snapshot) {
        if (entry.once) {
          removeListener(importMessageListeners, entry.listener);
          removeListener(leaseMessageListeners, entry.listener);
        }
        runTracked(() => invokeListener(entry.listener, event));
      }
    });
  }

  let controlChain: Promise<void> = Promise.resolve();

  function enqueueControl(message: ControlMessage) {
    controlChain = controlChain.then(async () => {
      if (message.type === "__detach") {
        await detach(message.seq, true);
        return;
      }
      if (activePort) await detach(activeSeq, false);
      activeSeq = message.seq;
      activePort = message.port;
      leaseMessageListeners = [];
      otherEvents = new EventTarget();
      if (installSession) attachFilesystem(message.seq, message.port, installSession);
      else attachStandard(message.seq, message.port);
    });
  }

  control.on("message", (message: ControlMessage) => {
    if (loadedReady) enqueueControl(message);
    else pendingControls.push(message);
  });
  loadedReady = true;
  for (const message of pendingControls) enqueueControl(message);
  control.on("close", () => {
    void detach(activeSeq, false).finally(() => stopNodeWorkers());
  });
}
