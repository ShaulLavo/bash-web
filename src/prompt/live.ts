import type { PromptLive } from "./types";

export interface WorkUnit<T> {
  run(): Promise<T> | T;
}

export interface WorkOptions {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly clock?: () => number;
}

export async function runWorkUnits<T>(
  units: readonly WorkUnit<T>[],
  options: WorkOptions,
): Promise<T[]> {
  const started = options.clock?.() ?? performance.now();
  const results: T[] = [];
  for (const unit of units) {
    if (
      options.signal.aborted ||
      (options.clock?.() ?? performance.now()) - started >= options.deadlineMs
    )
      break;
    results.push(await unit.run());
    await Promise.resolve();
  }
  return results;
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
      text === this.lastText
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
