import { createShell, runtimeSnapshot, SharedBridge, type Shell } from "../index";
import { control } from "../bridge";
import type { Runtime } from "waffle";

export type SessionOptions = {
  runtime: Runtime;
  /** Cancels pending startup and the session, without disposing the borrowed runtime. */
  signal?: AbortSignal;
  cols: number;
  rows: number;
  onOutput: (bytes: Uint8Array) => void;
  onState: (state: string) => void;
  trace?: boolean;
  startupTimeoutMs?: number;
};
type DeliverySpan = {
  startedAt: number;
  drainedAt: number;
  finishedAt: number;
  bytes: number;
  queuedBytes: number;
};
type FramePoint = { at: number; outputBytes: number };
type SessionMetrics = {
  startupMs: number;
  outputBytes: number;
  inputBytes: number;
  inputLatenciesMs: number[];
  outputFrames: number;
  wasmBytes: number;
  memoryBytes: number;
  deliveries: DeliverySpan[];
  frames: FramePoint[];
  traceDropped: number;
};
export class BrowserSession {
  private readonly bridge = new SharedBridge();
  private shell?: Shell;
  private pendingShell?: Promise<Shell>;
  private readonly admission = new AbortController();
  private readonly cancel = () => {
    void this.dispose();
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private phase = -1;
  private disposed = false;
  private disposal?: Promise<void>;
  private failed = false;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private pendingDiscard = false;
  private pendingInputTime = 0;
  private renderPending = false;
  private startupReject: ((reason: unknown) => void) | undefined;
  readonly metrics: SessionMetrics = {
    startupMs: 0,
    outputBytes: 0,
    inputBytes: 0,
    inputLatenciesMs: new Array<number>(),
    outputFrames: 0,
    wasmBytes: 0,
    memoryBytes: 0,
    deliveries: [],
    frames: [],
    traceDropped: 0,
  };
  private constructor(private readonly options: SessionOptions) {}
  static async create(options: SessionOptions): Promise<BrowserSession> {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "Shared memory requires HTTPS or localhost and COOP: same-origin / COEP: require-corp headers.",
      );
    }
    options.signal?.throwIfAborted();
    const session = new BrowserSession(options);
    options.signal?.addEventListener("abort", session.cancel, { once: true });
    const start = performance.now();
    try {
      session.resize(options.cols, options.rows);
      options.onState("starting");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const failure = new Promise<never>((_resolve, reject) => {
        session.startupReject = reject;
        const limit = options.startupTimeoutMs ?? 60000;
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Shell startup exceeded ${limit / 1000} seconds. Check the WASM asset and restart.`,
              ),
            ),
          limit,
        );
      });
      try {
        const result = await Promise.race([session.initializeRuntimeShell(), failure]);
        session.metrics.wasmBytes = result.wasmBytes;
      } finally {
        clearTimeout(timeout);
        session.startupReject = undefined;
      }
      session.metrics.startupMs = performance.now() - start;
      session.pump();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }
  private async initializeRuntimeShell(): Promise<{ wasmBytes: number }> {
    if (this.disposed) throw new Error("Shell startup was cancelled.");
    const shell = await (this.pendingShell = createShell({
      runtime: this.options.runtime,
      terminal: this.bridge,
      signal: this.admission.signal,
    }));
    if (this.disposed) throw new Error("Shell startup was cancelled.");
    this.shell = shell;
    void shell.done.then((result) => {
      if (result.error && !this.disposed) this.fail(result.error);
    });
    return { wasmBytes: shell.process.wasmBytes };
  }
  runtimeSnapshot() {
    if (!this.shell) return undefined;
    return {
      ...runtimeSnapshot(this.options.runtime),
      terminal: {
        inputCapacity: this.bridge.input.length,
        outputCapacity: this.bridge.output.length,
        inputQueued: this.bridge.availableInput(),
        outputQueued:
          (Atomics.load(this.bridge.state, control.outputWrite) -
            Atomics.load(this.bridge.state, control.outputRead)) >>>
          0,
      },
    };
  }
  input(bytes: Uint8Array) {
    if (this.disposed || this.failed) return;
    if (bytes.length === 1 && bytes[0] === 3) {
      this.queued = [];
      this.queuedBytes = 0;
      this.pendingInputTime = 0;
      this.renderPending = false;
      // Block terminal reads before signalling the guest. If an inherited reader
      // currently owns the input lock, the barrier keeps it from consuming stale
      // bytes while the next pump retries the bounded discard.
      this.bridge.interrupt();
      this.pendingDiscard = !this.bridge.discardInput();
      if (!this.pendingDiscard) this.bridge.resumeInput();
      if (this.shell) this.shell.interrupt();
      this.phase = -1;
      this.options.onState("interrupting");
      return;
    }
    if (bytes.length + this.queuedBytes > 262144) {
      this.options.onState(
        "warning: Input exceeds the 256 KiB paste queue. Paste a smaller selection.",
      );
      return;
    }
    this.pendingInputTime = performance.now();
    this.metrics.inputBytes += bytes.length;
    this.queued.push(bytes.slice());
    this.queuedBytes += bytes.length;
    this.flushInput();
  }
  resize(cols: number, rows: number) {
    Atomics.store(this.bridge.state, control.cols, Math.max(2, cols));
    Atomics.store(this.bridge.state, control.rows, Math.max(2, rows));
    Atomics.add(this.bridge.state, control.resize, 1);
    this.bridge.signal();
  }
  crash() {
    this.fail("Worker stopped unexpectedly. Restart the session to recover.");
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.startupReject?.(new Error("Shell startup was cancelled."));
    this.disposed = true;
    this.options.signal?.removeEventListener("abort", this.cancel);
    this.admission.abort(new Error("Shell startup was cancelled."));
    this.bridge.close();
    this.shell = undefined;
    clearTimeout(this.timer);
    this.queued = [];
    this.queuedBytes = 0;
    this.pendingDiscard = false;
    return (this.disposal = (async () => {
      // createShell guarantees rejected admission has completed its own cleanup.
      // A facade that wins the cancellation race is still ours to dispose and await.
      const shell = await this.pendingShell?.catch(() => undefined);
      await shell?.dispose();
    })());
  }
  markRendered() {
    if (this.options.trace && !this.disposed) {
      if (this.metrics.frames.length < 512)
        this.metrics.frames.push({
          at: performance.timeOrigin + performance.now(),
          outputBytes: this.metrics.outputBytes,
        });
      else this.metrics.traceDropped++;
    }
    if (!this.renderPending || !this.pendingInputTime || this.disposed) return;
    const samples = this.metrics.inputLatenciesMs;
    if (samples.length === 256) samples.shift();
    samples.push(performance.now() - this.pendingInputTime);
    this.pendingInputTime = 0;
    this.renderPending = false;
  }
  private fail(message: string) {
    this.startupReject?.(new Error(message));
    this.failed = true;
    this.bridge.close();
    clearTimeout(this.timer);
    this.options.onState(`failed: ${message}`);
    void this.dispose();
  }
  private flushInput() {
    if (this.pendingDiscard) {
      if (!this.bridge.discardInput()) return;
      this.pendingDiscard = false;
      this.bridge.resumeInput();
    }
    if (this.bridge.cancelled()) return;
    while (this.queued.length) {
      const bytes = this.queued[0];
      const chunk = bytes.subarray(0, 65536);
      if (!this.bridge.send(chunk)) return;
      this.queuedBytes -= chunk.length;
      if (chunk.length === bytes.length) {
        this.queued.shift();
        continue;
      }
      this.queued[0] = bytes.subarray(chunk.length);
    }
  }
  private pump() {
    if (this.disposed || this.failed) return;
    this.flushInput();
    const startedAt = this.options.trace ? performance.timeOrigin + performance.now() : 0;
    const queuedBytes = this.options.trace
      ? (Atomics.load(this.bridge.state, control.outputWrite) -
          Atomics.load(this.bridge.state, control.outputRead)) >>>
        0
      : 0;
    const output = this.bridge.drain();
    const drainedAt = this.options.trace ? performance.timeOrigin + performance.now() : 0;
    if (output.length) this.deliver(output);
    if (this.options.trace && output.length) {
      if (this.metrics.deliveries.length < 512)
        this.metrics.deliveries.push({
          startedAt,
          drainedAt,
          finishedAt: performance.timeOrigin + performance.now(),
          bytes: output.length,
          queuedBytes,
        });
      else this.metrics.traceDropped++;
    }
    if (this.disposed || this.failed) return;
    this.metrics.memoryBytes = Atomics.load(this.bridge.state, control.memory);
    const phase = Atomics.load(this.bridge.state, control.phase);
    if (phase === 4) {
      this.fail("Shared terminal failed; the session was stopped.");
      return;
    }
    if (phase !== this.phase && !this.bridge.cancelled()) {
      this.phase = phase;
      this.options.onState(
        ["starting", "ready", "running", "exited"][phase] ?? "Worker failed. Restart the session.",
      );
    }
    if (this.disposed || this.failed) return;
    if (
      phase === 3 &&
      Atomics.load(this.bridge.state, control.outputWrite) ===
        Atomics.load(this.bridge.state, control.outputRead)
    ) {
      void this.dispose();
      return;
    }
    this.timer = setTimeout(() => this.pump(), 8);
  }
  private deliver(bytes: Uint8Array) {
    this.metrics.outputBytes += bytes.length;
    this.metrics.outputFrames++;
    if (this.pendingInputTime) this.renderPending = true;
    this.options.onOutput(bytes);
  }
}
