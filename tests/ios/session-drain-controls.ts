import { createContext, runInContext, type Context } from "node:vm";
import type { HostCase } from "waffle/testing/page-runner";

export type DrainOperation =
  | { kind: "script" | "task"; source: string }
  | { kind: "sleep"; ms: number };

export class ControlledDrainHost implements HostCase {
  async allocateDatabase(): Promise<string> {
    throw new Error("Memory-only session drain must not allocate durable storage");
  }

  readonly signal = new AbortController().signal;
  readonly operations: DrainOperation[] = [];
  readonly context: Context;
  setupFailure = false;
  corruptInterior = false;
  wrongPhase = false;
  wrongTerminalBytes = false;
  extraObserverDelay = false;
  extraObserverWait = false;
  driverScriptTimer = false;
  deferredWrite = false;
  burstTurns = 1;
  maximumDelivery = 1000;
  setupRemaining = 60_000;
  disposed = 0;
  moduleLoads = 0;
  raceCalls = 0;
  readonly state: {
    output: number[];
    states: string[];
    consumed: number[];
    acknowledgements: number;
    turns: number;
    terminalBytes: number;
  } = {
    output: [],
    states: ["ready"],
    consumed: [],
    acknowledgements: 0,
    turns: 0,
    terminalBytes: -1,
  };
  private pending: number[] = [];
  private available = 0;
  private locked = false;

  constructor() {
    const state = new Int32Array(new SharedArrayBuffer(128));
    const bridge = {
      state,
      drain: () => new Uint8Array([42]),
      receive: (size: number) => {
        this.pending.splice(0, size);
        this.available = Math.min(65536, this.pending.length);
      },
      availableInput: () => this.available,
      signal: () => {},
    };
    const session = {
      ...this.state,

      input: (bytes: number[]) => this.input(bytes),
      action: (kind: string, bytes?: number[]) => this.action(kind, bytes),
      dispose: async () => {
        this.disposed++;
      },
      race: () => {
        this.raceCalls++;
        this.state.output = [77];
      },
    };
    Object.defineProperty(session, "maximumDelivery", { get: () => this.maximumDelivery });
    for (const key of Object.keys(this.state))
      Object.defineProperty(session, key, { get: () => Reflect.get(this.state, key) });
    const window = { sessionDrain: session, setTimeout: () => 1 };
    this.context = createContext({
      window,
      drainBridge: bridge,
      document: {
        createElement: () => ({}),
        head: { append: (script: unknown) => this.load(script) },
      },
      Atomics: { store: Atomics.store, waitAsync: () => ({ async: true }) },
    });
  }

  remainingMs(): number {
    return this.setupRemaining;
  }
  async sleep(ms: number): Promise<void> {
    this.operations.push({ kind: "sleep", ms });
  }
  async script(source: string): Promise<unknown> {
    this.operations.push({ kind: "script", source });
    const result = structuredClone(runInContext(`(() => {${source}\n})()`, this.context));
    this.scheduleDriverTimer();
    return result;
  }
  async task(source: string): Promise<void> {
    this.operations.push({ kind: "task", source });
    if (this.driverScriptTimer) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
        this.scheduleDriverTimer();
      });
    }
    await runInContext(`(async () => {${source}\n})()`, this.context);
  }
  private scheduleDriverTimer(): void {
    if (this.driverScriptTimer) runInContext("window.setTimeout(() => {}, 3000);", this.context);
  }
  private load(script: unknown): void {
    this.moduleLoads++;
    this.state.acknowledgements = 1;
    Reflect.get(Object(script), this.setupFailure ? "onerror" : "onload")();
  }
  private input(bytes: number[]): void {
    if (bytes.length === 1 && bytes[0] === 3) {
      this.pending = [];
      this.available = 0;
      return;
    }
    this.pending = this.pending.concat(bytes);
    this.available = Math.min(65536, this.pending.length);
  }
  private action(kind: string, bytes: number[] = []): void {
    if (kind === "phase") {
      this.state.states.push(bytes[0] === 2 ? "running" : "ready");
      return;
    }
    if (kind === "lock") {
      this.locked = true;
      this.state.acknowledgements++;
      return;
    }
    if (kind === "unlock") {
      this.locked = false;
      this.state.states.push("ready");
      return;
    }
    if (kind === "receive" || kind === "consume") {
      this.consume();
      return;
    }
    if (kind === "burst") {
      this.burst();
      return;
    }
    if (kind === "exit" || kind === "fail") {
      this.terminal(kind, bytes);
      return;
    }
    if (kind !== "write") return;
    if (this.deferredWrite) {
      setTimeout(() => this.write(bytes), 0);
      return;
    }
    this.write(bytes);
  }
  private consume(): void {
    if (this.locked) return;
    const bytes = this.pending.splice(0, 65536);
    this.state.consumed = this.state.consumed.concat(bytes);
    this.available = Math.min(65536, this.pending.length);
    if (this.corruptInterior && this.state.consumed.length === 196608)
      this.state.consumed[98304] = -1;
  }
  private burst(): void {
    this.state.output = Array.from({ length: 1000 }, (_, i) => 32 + (i % 200));
    this.state.turns += this.burstTurns;
  }
  private terminal(kind: string, bytes: number[]): void {
    this.state.output = bytes;
    if (this.corruptInterior) this.state.output[50000] = -1;
    this.state.terminalBytes = this.wrongTerminalBytes ? 99999 : bytes.length;
    this.state.states.push(this.wrongPhase ? "ready" : kind === "exit" ? "exited" : "failed");
  }
  private write(bytes: number[]): void {
    this.state.output = this.state.output.concat(bytes);
    runInContext(
      `drainBridge.drain();
      if (Atomics.load) throw new Error("Unexpected observer");
      if (Reflect.has(window, "drainWaits")) {
        ${this.extraObserverDelay ? "window.setTimeout(() => {}, 10);" : ""}
        window.setTimeout(() => {}, 8);
        ${this.extraObserverWait ? "Atomics.waitAsync(drainBridge.state, 0, 0);" : ""}
        Atomics.waitAsync(drainBridge.state, 0, 0);
      }
      if (drainBridge.state[11] === 2) window.sessionDrain.states.push("running");`,
      this.context,
    );
  }
}
