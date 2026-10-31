import type { PromptLive } from "./types";

export class WorkBudget {
  #deadline: number;
  #yielded = performance.now();
  readonly #started: number;
  readonly #clock: () => number;
  constructor(
    readonly signal: AbortSignal,
    durationMs: number,
    clock = () => performance.now(),
  ) {
    this.#clock = clock;
    this.#started = clock();
    this.#deadline = this.#started + durationMs;
  }
  setDuration(durationMs: number): void {
    this.#deadline = this.#started + durationMs;
  }
  get active(): boolean {
    return !this.signal.aborted && this.#clock() < this.#deadline;
  }
  async checkpoint(): Promise<void> {
    this.check();
    if (performance.now() - this.#yielded < 4) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.#yielded = performance.now();
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
  #pending: string | undefined;
  #scheduled = false;
  #lastText = "";

  readonly #generation: number;
  readonly #currentGeneration: () => number;
  readonly #onUpdate: (text: string) => void;
  constructor(
    readonly signal: AbortSignal,
    generation: number,
    currentGeneration: () => number,
    onUpdate: (text: string) => void,
  ) {
    this.#generation = generation;
    this.#currentGeneration = currentGeneration;
    this.#onUpdate = onUpdate;
  }

  update(text: string): void {
    if (
      this.signal.aborted ||
      this.#currentGeneration() !== this.#generation ||
      (!this.#scheduled && text === this.#lastText)
    )
      return;
    this.#pending = text;
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (
        this.signal.aborted ||
        this.#currentGeneration() !== this.#generation ||
        this.#pending === undefined
      )
        return;
      const next = this.#pending;
      this.#pending = undefined;
      if (next === this.#lastText) return;
      this.#lastText = next;
      this.#onUpdate(next);
    });
  }
}
