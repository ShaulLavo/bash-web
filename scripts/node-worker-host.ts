// Threads take no parent CLI flags: test-runner and stdin-module flags are not theirs.
import { existsSync } from "node:fs";
import { MessageChannel, MessagePort, Worker as Thread } from "node:worker_threads";

const MAX_IDLE_PER_ENTRY = 2;
const SETTLE_WAIT_MS = 100;

function resolveBootstrap(): URL {
  for (const candidate of [
    new URL("./thread.mjs", import.meta.url),
    new URL("../.build/node/thread.mjs", import.meta.url),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return new URL("./node-worker-thread.ts", import.meta.url);
}

function isPoolableEntry(entry: string): boolean {
  return (
    entry.endsWith("/.build/node/fs.mjs") ||
    entry.endsWith("/.build/node/root.mjs") ||
    entry.endsWith("/.build/node/child.mjs") ||
    entry.endsWith("/.build/node/preview1.mjs")
  );
}

interface PooledThread {
  readonly entry: string;
  readonly thread: Thread;
  dead: boolean;
  onSettled: ((seq: number) => void) | null;
  onError: ((error: unknown) => void) | null;
  onMessageError: ((data: unknown) => void) | null;
  onExit: (() => void) | null;
}

interface WorkerControlPayload {
  type?: unknown;
  seq?: unknown;
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

const idlePool = new Map<string, PooledThread[]>();
const live = new Set<NodeWorker>();
let nextSeq = 0;

function removeIdleThread(pooled: PooledThread): void {
  const bucket = idlePool.get(pooled.entry);
  if (!bucket) return;
  const index = bucket.indexOf(pooled);
  if (index >= 0) bucket.splice(index, 1);
}

function reviveWorkerError(payload: WorkerControlPayload): Error {
  const message = typeof payload.message === "string" ? payload.message : "Worker handler failed";
  const error = new Error(message);
  if (typeof payload.name === "string" && payload.name) error.name = payload.name;
  if (typeof payload.stack === "string" && payload.stack) error.stack = payload.stack;
  return error;
}

function acquirePooledThread(entry: string): PooledThread {
  const bucket = idlePool.get(entry);
  while (bucket && bucket.length > 0) {
    const candidate = bucket.pop()!;
    if (candidate.dead) continue;
    candidate.thread.ref();
    return candidate;
  }
  const thread = new Thread(resolveBootstrap(), {
    workerData: { entry, pooled: true },
    execArgv: [],
  });
  const pooled: PooledThread = {
    entry,
    thread,
    dead: false,
    onSettled: null,
    onError: null,
    onMessageError: null,
    onExit: null,
  };
  thread.on("exit", () => {
    pooled.dead = true;
    removeIdleThread(pooled);
    pooled.onExit?.();
  });
  thread.on("message", (data: unknown) => {
    const record = data as WorkerControlPayload | null;
    if (record?.type === "__settled" && typeof record.seq === "number") {
      pooled.onSettled?.(record.seq);
    } else if (record?.type === "__error" && typeof record.seq === "number") {
      pooled.dead = true;
      pooled.onError?.(reviveWorkerError(record));
    }
  });
  thread.on("error", (error) => {
    pooled.dead = true;
    removeIdleThread(pooled);
    pooled.onError?.(error);
  });
  thread.on("messageerror", (data) => {
    pooled.dead = true;
    removeIdleThread(pooled);
    pooled.onMessageError?.(data);
  });
  return pooled;
}

function clearPooledHandlers(pooled: PooledThread): void {
  pooled.onSettled = null;
  pooled.onError = null;
  pooled.onMessageError = null;
  pooled.onExit = null;
}

function releasePooledThread(pooled: PooledThread): boolean {
  if (pooled.dead) return false;
  let bucket = idlePool.get(pooled.entry);
  if (!bucket) {
    bucket = [];
    idlePool.set(pooled.entry, bucket);
  }
  if (bucket.length >= MAX_IDLE_PER_ENTRY) return false;
  clearPooledHandlers(pooled);
  pooled.thread.unref();
  bucket.push(pooled);
  return true;
}

function filterTransfers(transfer: readonly unknown[]): (ArrayBuffer | MessagePort)[] {
  return transfer.filter(
    (value): value is ArrayBuffer | MessagePort =>
      value instanceof ArrayBuffer || value instanceof MessagePort,
  );
}

function isCleanCompletionMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as { type?: unknown; error?: unknown; cleanupErrors?: unknown };
  if (record.type === "exit") {
    return (
      record.error === undefined &&
      (!Array.isArray(record.cleanupErrors) || record.cleanupErrors.length === 0)
    );
  }
  return record.type === "filesystem-disposed" && typeof record.error !== "string";
}

class WorkerFailure extends Event {
  readonly error: Error;
  constructor(error: Error) {
    super("error", { cancelable: true });
    this.error = error;
  }
  get message() {
    return this.error.message;
  }
}

class NodeWorker extends EventTarget {
  readonly thread: Thread;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: WorkerFailure) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private readonly pooled?: PooledThread;
  private readonly hostPort?: MessagePort;
  private readonly isFilesystemWorker: boolean;
  private readonly seq = ++nextSeq;
  private settled = false;
  private sawCleanCompletion = false;
  private errored = false;
  private settleWaiter: ((ok: boolean) => void) | null = null;
  private termination?: Promise<number>;

  constructor(url: string | URL) {
    super();
    const entry = String(url);
    this.isFilesystemWorker = entry.endsWith("/.build/node/fs.mjs");
    live.add(this);
    if (isPoolableEntry(entry)) {
      const pooled = acquirePooledThread(entry);
      const { port1, port2 } = new MessageChannel();
      this.pooled = pooled;
      this.thread = pooled.thread;
      this.hostPort = port1;
      this.bindPooled(pooled, port1, port2);
      return;
    }
    this.thread = new Thread(resolveBootstrap(), {
      workerData: { entry, pooled: false },
      execArgv: [],
    });
    this.thread.on("exit", () => live.delete(this));
    this.thread.on("message", (data) => this.emitMessage(data));
    this.thread.on("messageerror", (data) => this.emitMessageError(data));
    this.thread.on("error", (error) => this.emitError(error));
  }

  private resolveSettleWaiter(ok: boolean) {
    const notify = this.settleWaiter;
    this.settleWaiter = null;
    notify?.(ok);
  }

  private bindPooled(pooled: PooledThread, hostPort: MessagePort, workerPort: MessagePort) {
    pooled.onSettled = (seq) => {
      if (seq !== this.seq) return;
      this.settled = true;
      this.resolveSettleWaiter(true);
    };
    pooled.onError = (error) => {
      this.errored = true;
      this.resolveSettleWaiter(false);
      this.emitError(error);
      void this.retireBrokenThread(pooled);
    };
    pooled.onMessageError = (data) => {
      this.errored = true;
      this.resolveSettleWaiter(false);
      this.emitMessageError(data);
      void this.retireBrokenThread(pooled);
    };
    pooled.onExit = () => {
      this.resolveSettleWaiter(false);
      this.hostPort?.removeAllListeners();
      this.hostPort?.close();
      if (!this.termination) live.delete(this);
    };
    hostPort.on("message", (data) => {
      if (isCleanCompletionMessage(data)) this.sawCleanCompletion = true;
      this.emitMessage(data);
    });
    hostPort.on("messageerror", (data) => {
      this.errored = true;
      this.resolveSettleWaiter(false);
      this.emitMessageError(data);
    });
    pooled.thread.postMessage({ type: "__attach", seq: this.seq, port: workerPort }, [workerPort]);
  }

  private retireBrokenThread(pooled: PooledThread): Promise<number> {
    if (this.termination) return this.termination;
    pooled.dead = true;
    this.hostPort?.removeAllListeners();
    this.hostPort?.close();
    clearPooledHandlers(pooled);
    this.termination = pooled.thread.terminate().finally(() => {
      live.delete(this);
    });
    return this.termination;
  }

  private emitMessage(data: unknown) {
    const event = new MessageEvent("message", { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  private emitMessageError(data: unknown) {
    const event = new MessageEvent("messageerror", { data });
    this.onmessageerror?.(event);
    this.dispatchEvent(event);
  }

  private emitError(error: unknown) {
    const event = new WorkerFailure(error instanceof Error ? error : new Error(String(error)));
    this.onerror?.(event);
    this.dispatchEvent(event);
  }

  postMessage(message: unknown, transfer: readonly unknown[] = []) {
    this.sawCleanCompletion = false;
    this.settled = false;
    if (this.hostPort) {
      this.hostPort.postMessage(message, filterTransfers(transfer));
      return;
    }
    this.thread.postMessage(message, filterTransfers(transfer));
  }

  private async waitForSettle(pooled: PooledThread): Promise<boolean> {
    if (this.settled) return true;
    if (this.errored || pooled.dead) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.settleWaiter = null;
        resolve(this.settled && !this.errored && !pooled.dead);
      }, SETTLE_WAIT_MS);
      timer.unref();
      this.settleWaiter = (ok) => {
        clearTimeout(timer);
        resolve(ok && !this.errored && !pooled.dead);
      };
    });
  }

  private async finishPooled(pooled: PooledThread): Promise<number> {
    this.hostPort?.removeAllListeners();
    this.hostPort?.close();
    const eligible =
      !this.errored && !pooled.dead && (this.isFilesystemWorker || this.sawCleanCompletion);
    if (eligible) {
      pooled.thread.postMessage({ type: "__detach", seq: this.seq });
      if ((await this.waitForSettle(pooled)) && releasePooledThread(pooled)) {
        return 0;
      }
    }
    pooled.dead = true;
    clearPooledHandlers(pooled);
    return pooled.thread.terminate();
  }

  terminate() {
    if (this.termination) return this.termination;
    const done = this.pooled ? this.finishPooled(this.pooled) : this.thread.terminate();
    this.termination = done.finally(() => {
      live.delete(this);
    });
    return this.termination;
  }
}

export function liveNodeWorkers(): number {
  return live.size;
}

export function installNodeWorkers(): void {
  Object.defineProperty(globalThis, "Worker", { value: NodeWorker, configurable: true });
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
}

export async function stopNodeWorkers(): Promise<void> {
  await Promise.all(Array.from(live, (worker) => worker.terminate()));
}
