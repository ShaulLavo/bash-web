import { parentPort, workerData, MessagePort } from "node:worker_threads";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";

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
  let activeCleanup: (() => void) | null = null;
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
        options?: boolean | EventListenerOptions,
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

  function detach(seq: number) {
    if (activeSeq !== seq || !activePort) return;
    const port = activePort;
    const cleanup = activeCleanup;
    activePort = null;
    activeCleanup = null;
    events = new EventTarget();
    port.removeAllListeners();
    if (cleanup) cleanup();
    port.close();
    void stopNodeWorkers();
  }

  function attachFilesystem(
    seq: number,
    port: MessagePort,
    install: NonNullable<typeof installSession>,
  ) {
    let detached = false;
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(message: unknown, transfer: readonly unknown[] = []) {
        const record = message as { type?: unknown; error?: unknown } | null;
        if (detached) {
          if (record?.type === "filesystem-disposed" && typeof record.error !== "string") {
            control.postMessage({ type: "__settled", seq });
          }
          return;
        }
        if (activeSeq !== seq) return;
        port.postMessage(message, filterTransfers(transfer));
        if (record?.type === "filesystem-disposed" && typeof record.error !== "string") {
          control.postMessage({ type: "__settled", seq });
        }
      },
    };
    install(scope);
    activeCleanup = () => {
      detached = true;
      scope.onmessage?.(new MessageEvent("message", { data: { dispose: true } }));
    };
    port.on("message", (payload) => {
      if (activeSeq !== seq) return;
      scope.onmessage?.(new MessageEvent("message", { data: payload }));
    });
  }

  function attachStandard(seq: number, port: MessagePort) {
    port.on("message", (payload) => {
      if (activeSeq !== seq) return;
      const event = new MessageEvent("message", { data: payload });
      const listener: unknown = Reflect.get(globalThis, "onmessage");
      let outcome: unknown;
      if (typeof listener === "function") outcome = listener.call(globalThis, event);
      events.dispatchEvent(event);
      Promise.resolve(outcome).then(
        () => {
          if (activeSeq === seq) control.postMessage({ type: "__settled", seq });
        },
        () => {
          // Unsettled rejection forces the host to terminate this thread.
        },
      );
    });
  }

  function handleControl(message: ControlMessage) {
    if (message.type === "__detach") {
      detach(message.seq);
      return;
    }
    if (activePort) detach(activeSeq);
    activeSeq = message.seq;
    activePort = message.port;
    events = new EventTarget();
    if (installSession) attachFilesystem(message.seq, message.port, installSession);
    else attachStandard(message.seq, message.port);
  }

  control.on("message", (message: ControlMessage) => {
    if (loadedReady) handleControl(message);
    else pendingControls.push(message);
  });
  loadedReady = true;
  for (const message of pendingControls) handleControl(message);
  control.on("close", () => {
    if (activePort) detach(activeSeq);
    void stopNodeWorkers();
  });
}
