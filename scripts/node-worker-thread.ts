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
  let events = new EventTarget();
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
      ) => events.addEventListener(type, listener, options),
      configurable: true,
    },
    removeEventListener: {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => events.removeEventListener(type, listener, options),
      configurable: true,
    },
  });

  await import(data.entry);
  const candidate: unknown = Reflect.get(globalThis, "__bashWebInstallSession");
  const installSession =
    typeof candidate === "function" ? (candidate as InstallSession) : undefined;
  let loadedReady = false;
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
      events = new EventTarget();
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
      inFlight += 1;
      const event = new MessageEvent("message", { data: payload });
      const listener: unknown = Reflect.get(globalThis, "onmessage");
      let outcome: unknown;
      try {
        if (typeof listener === "function") outcome = listener.call(globalThis, event);
        events.dispatchEvent(event);
      } catch (error) {
        failLease(error);
        finishOne();
        return;
      }
      Promise.resolve(outcome).catch(failLease).finally(finishOne);
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
      events = new EventTarget();
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
