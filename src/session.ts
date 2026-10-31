import {
  createShell,
  runtimeSnapshot,
  SharedBridge,
  TerminalNewlines,
  type Shell,
  type ShellOptions,
  type ShellPrompt,
} from "./index";
import { control } from "./bridge";
import type { SharedFilesystemState } from "waffle";
import { waitForStorage, type StorageStartup } from "./runtime/storage";

export type SessionState = "starting" | "ready" | "running" | "exited" | "failed";

/** Interactive createShell options, plus the terminal view's callbacks and dimensions. */
export type SessionOptions = Omit<ShellOptions, "terminal" | "script"> & {
  storageStartup?: StorageStartup;
  onStorageState?: (state: SharedFilesystemState) => void;
  /** Cancels startup and the running session, never the borrowed runtime. */
  signal?: AbortSignal;
  cols: number;
  rows: number;
  /** Final display bytes, with bare LF translated to CRLF across output chunks. */
  onOutput: (bytes: Uint8Array) => void;
  onState: (state: SessionState, detail?: string) => void;
  trace?: boolean;
  /** Shell admission and the first prompt, after storage becomes ready. Default 60000. */
  startupTimeoutMs?: number;
};
const PASTE_LIMIT = 262144;
const INPUT_CHUNK = 65536;
const encoder = new TextEncoder();
type DeliverySpan = {
  startedAt: number;
  drainedAt: number;
  finishedAt: number;
  bytes: number;
  queuedBytes: number;
};
type FramePoint = { at: number; outputBytes: number };
export type SessionMetrics = {
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
  private readonly newlines = new TerminalNewlines();
  private receipt?: ShellPrompt;
  private currentState?: SessionState;
  private submissions = Promise.resolve();
  private pendingSubmissions = 0;
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
  private failureMessage = "Shared terminal failed; the session was stopped.";
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
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "Shared memory requires HTTPS or localhost and COOP: same-origin / COEP: require-corp headers.",
      );
    }
    if (typeof Atomics.waitAsync !== "function")
      throw new Error("BrowserSession requires Atomics.waitAsync support.");
    options.signal?.throwIfAborted();
    const session = new BrowserSession(options);
    options.signal?.addEventListener("abort", session.cancel, { once: true });
    const start = performance.now();
    try {
      session.resize(options.cols, options.rows);
      session.setState("starting");
      if (options.runtime.filesystem.state.status !== "ready") {
        await waitForStorage(options.runtime, session.admission.signal, {
          startup: options.storageStartup,
          onStartupStage: options.onStartupStage,
          onState: options.onStorageState,
        });
      }
      session.admission.signal.throwIfAborted();
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
      return session;
    } catch (error) {
      if (!session.disposed)
        session.setState("failed", error instanceof Error ? error.message : String(error));
      await session.dispose();
      throw error;
    }
  }
  private async initializeRuntimeShell(): Promise<{ wasmBytes: number }> {
    if (this.disposed) throw new Error("Shell startup was cancelled.");
    const shell = await (this.pendingShell = createShell({
      ...this.options,
      terminal: this.bridge,
      signal: this.admission.signal,
    }));
    if (this.disposed) throw new Error("Shell startup was cancelled.");
    this.shell = shell;
    void shell.done.then((result) => {
      if (this.disposed) return;
      if (result.error) this.failureMessage = result.error;
      this.bridge.signal();
    });
    this.pump();
    this.acceptPrompt(await shell.waitForPrompt({ signal: this.admission.signal }));
    return { wasmBytes: shell.process.wasmBytes };
  }
  get state(): SessionState {
    return this.currentState ?? "starting";
  }
  get running(): boolean {
    return (
      !this.disposed &&
      (this.pendingSubmissions > 0 || Atomics.load(this.bridge.state, control.phase) === 2)
    );
  }
  get lastPrompt(): ShellPrompt | undefined {
    return this.receipt;
  }
  get lastExit(): number {
    return this.receipt?.status ?? 0;
  }
  /** Replace the whole draft and resolve after the next prompt and output handoff. */
  submit(command: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Shell is closed"));
    this.pendingSubmissions++;
    const submitted = this.submissions.then(() => this.submitOne(command));
    this.submissions = submitted.catch(() => {});
    return submitted.finally(() => {
      this.pendingSubmissions--;
    });
  }
  private async submitOne(command: string): Promise<void> {
    const shell = this.shell;
    if (!shell || this.disposed) throw new Error("Shell is closed");
    if (Atomics.load(this.bridge.state, control.phase) === 2)
      throw new Error("Shell is running a foreground command");
    const ready = await shell.waitForPrompt({ signal: this.admission.signal });
    // Ctrl+E reaches the whole draft's end in zsh mode; Ctrl+U and Ctrl+K clear both sides.
    this.input(`\x05\x15\x0b${command}\r`);
    this.acceptPrompt(
      await shell.waitForPrompt({ after: ready.generation, signal: this.admission.signal }),
    );
  }
  private acceptPrompt(receipt: ShellPrompt): void {
    if (this.disposed || (this.receipt && receipt.generation <= this.receipt.generation)) return;
    // The guest publishes before the page pump. Hand off all queued output before settling submit.
    const output = this.bridge.drain(this.bridge.output.length);
    if (output.length) this.deliver(output);
    if (this.disposed) return;
    this.receipt = receipt;
    if (Atomics.load(this.bridge.state, control.phase) === 1 && !this.bridge.cancelled())
      this.setState("ready");
  }
  private setState(state: SessionState, detail?: string): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.options.onState(state, detail);
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
  /** Queue a copied input chunk. Oversized pastes throw without accepting any of that call. */
  input(data: string | Uint8Array): void {
    if (this.disposed || this.failed) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.length === 1 && bytes[0] === 3) return this.interrupt();
    if (bytes.length + this.queuedBytes > PASTE_LIMIT)
      throw new RangeError("Input exceeds the 256 KiB paste queue. Paste a smaller selection.");
    if (!bytes.length) return;
    this.pendingInputTime = performance.now();
    this.metrics.inputBytes += bytes.length;
    this.queued.push(bytes.slice());
    this.queuedBytes += bytes.length;
    this.flushInput();
  }
  /** Drop typed-ahead input, then deliver Ctrl+C to the shell's foreground job. */
  interrupt(): void {
    if (this.disposed || this.failed) return;
    this.queued = [];
    this.queuedBytes = 0;
    this.pendingInputTime = 0;
    this.renderPending = false;
    this.bridge.interrupt();
    this.pendingDiscard = !this.bridge.discardInput();
    if (!this.pendingDiscard) this.bridge.resumeInput();
    this.shell?.interrupt();
    this.phase = -1;
    this.schedulePump();
  }
  resize(cols: number, rows: number) {
    if (!this.disposed) this.bridge.resize(cols, rows);
  }
  crash() {
    if (this.disposed || this.failed) return;
    this.failureMessage = "Worker stopped unexpectedly. Restart the session to recover.";
    Atomics.store(this.bridge.state, control.phase, 4);
    this.bridge.signal();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = Promise.resolve().then(async () => {
      const shell = await this.pendingShell?.catch(() => undefined);
      await shell?.dispose();
    });
    this.disposed = true;
    this.startupReject?.(new Error("Shell startup was cancelled."));
    this.options.signal?.removeEventListener("abort", this.cancel);
    this.admission.abort(new Error("Shell startup was cancelled."));
    this.bridge.close();
    this.shell = undefined;
    clearTimeout(this.timer);
    this.queued = [];
    this.queuedBytes = 0;
    this.pendingDiscard = false;
    return this.disposal;
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
    if (this.disposed || this.failed) return;
    this.startupReject?.(new Error(message));
    this.failed = true;
    this.bridge.close();
    clearTimeout(this.timer);
    this.setState("failed", message);
    void this.dispose();
  }
  private flushInput() {
    if (this.pendingDiscard) {
      if (!this.bridge.discardInput()) return;
      this.pendingDiscard = false;
      this.bridge.resumeInput();
    }
    if (this.bridge.cancelled()) return;
    while (true) {
      const bytes = this.queued[0];
      if (!bytes) break;
      const chunk = bytes.subarray(0, INPUT_CHUNK);
      const accepted = this.bridge.send(chunk);
      if (!accepted) return;
      this.queuedBytes -= accepted;
      if (accepted === bytes.length) {
        this.queued.shift();
        continue;
      }
      this.queued[0] = bytes.subarray(accepted);
      if (accepted < chunk.length) return;
    }
  }
  private pump() {
    if (this.disposed || this.failed) return;
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
    const sequence = Atomics.load(this.bridge.state, control.wake);
    this.flushInput();
    this.metrics.memoryBytes = Atomics.load(this.bridge.state, control.memory);
    const phase = Atomics.load(this.bridge.state, control.phase);
    const outputPending =
      Atomics.load(this.bridge.state, control.outputWrite) !==
      Atomics.load(this.bridge.state, control.outputRead);
    if (phase >= 3 && outputPending) {
      this.schedulePump();
      return;
    }
    if (phase === 4) {
      this.fail(this.failureMessage);
      return;
    }
    if (phase !== this.phase && !this.bridge.cancelled()) {
      this.phase = phase;
      if (phase === 1 && this.receipt) this.setState("ready");
      if (phase === 2) this.setState("running");
      if (phase === 3) this.setState("exited");
    }
    const receipt = this.bridge.readPrompt();
    if (receipt) this.acceptPrompt(receipt);
    if (this.disposed || this.failed) return;
    if (
      phase === 3 &&
      Atomics.load(this.bridge.state, control.outputWrite) ===
        Atomics.load(this.bridge.state, control.outputRead)
    ) {
      void this.dispose();
      return;
    }
    if (outputPending) this.schedulePump();
    else this.waitForActivity(sequence);
  }
  private schedulePump() {
    if (this.disposed || this.failed || this.timer !== undefined) return;
    const outputPending =
      Atomics.load(this.bridge.state, control.outputWrite) !==
      Atomics.load(this.bridge.state, control.outputRead);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.pump();
      },
      outputPending ? 8 : 0,
    );
  }
  private waitForActivity(sequence: number) {
    const wait = Atomics.waitAsync(this.bridge.state, control.wake, sequence);
    if (wait.async) void wait.value.then(() => this.schedulePump());
    else this.schedulePump();
  }
  private deliver(bytes: Uint8Array) {
    this.metrics.outputBytes += bytes.length;
    this.metrics.outputFrames++;
    if (this.pendingInputTime) this.renderPending = true;
    this.newlines.write(bytes, this.options.onOutput);
  }
}
