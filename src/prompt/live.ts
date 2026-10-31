import type { PromptLive } from "./types";

export class WorkBudget {
  private deadline: number;
  private yielded = performance.now();
  private readonly started: number;
  constructor(
    readonly signal: AbortSignal,
    durationMs: number,
    private readonly clock = () => performance.now(),
  ) {
    this.started = clock();
    this.deadline = this.started + durationMs;
  }
  setDuration(durationMs: number): void {
    this.deadline = this.started + durationMs;
  }
  get active(): boolean {
    return !this.signal.aborted && this.clock() < this.deadline;
  }
  async checkpoint(): Promise<void> {
    this.check();
    if (performance.now() - this.yielded < 4) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.yielded = performance.now();
    this.check();
  }
  check(): void {
    if (!this.active) throw new Error(this.signal.aborted ? "cancelled" : "deadline");
  }
  async run<T>(work: () => T | Promise<T>): Promise<T | undefined> {
    if (!this.active) return undefined;
    const value = await work();
    return this.active ? value : undefined;
  }
}

export class PromptTurnLive implements PromptLive {
  private pending: string | undefined;
  private scheduled = false;
  private lastText = "";

  constructor(
    readonly signal: AbortSignal,
    private readonly generation: number,
    private readonly currentGeneration: () => number,
    private readonly onUpdate: (text: string) => void,
  ) {}

  update(text: string): void {
    if (
      this.signal.aborted ||
      this.currentGeneration() !== this.generation ||
      (!this.scheduled && text === this.lastText)
    )
      return;
    this.pending = text;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (
        this.signal.aborted ||
        this.currentGeneration() !== this.generation ||
        this.pending === undefined
      )
        return;
      const next = this.pending;
      this.pending = undefined;
      if (next === this.lastText) return;
      this.lastText = next;
      this.onUpdate(next);
    });
  }
}
