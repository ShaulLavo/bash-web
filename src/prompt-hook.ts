// Original. The prompt hook's public types. A page passes a PromptProvider to
// createShell, and the shell asks it for the text of each interactive prompt.

export interface PromptContext {
  /** Counts prompts in this shell, starting at 1. */
  readonly turn: number;
  /** The shell's logical working directory ($PWD). */
  readonly cwd: string;
  /** $? after the last command. */
  readonly status: number;
  /** ${PIPESTATUS[@]} after the last command. */
  readonly pipestatus: readonly number[];
  /** Wall time of the last command. Undefined when no command ran since the
   * previous prompt: the first prompt, an empty line, or Ctrl+C at the prompt. */
  readonly durationMs: number | undefined;
  /** Live background jobs owned by this shell. */
  readonly jobs: number;
  readonly columns: number;
  readonly rows: number;
  readonly lineEditor: "bash" | "zsh";
  /** The text the shell draws when the provider answers null, fails or is late. */
  readonly ps1: string;
  /** Current values of the shell variables named in PromptProvider.variables.
   * Unset variables are absent. Includes unexported shell variables. */
  readonly variables: ReadonlyMap<string, string>;
  /** Aborted when the shell stops waiting for the first answer (100 ms). */
  readonly signal: AbortSignal;
}

/** The prompt while it is on screen. */
export interface PromptLive {
  /** Aborted when this prompt ends: Enter, Ctrl+C, end of input, or shell disposal. */
  readonly signal: AbortSignal;
  /** Replace the prompt in place. Only the latest text is applied; calls after
   * the signal aborts are ignored. Best effort: the shell declines while the prompt
   * row is out of reach or after other output, and shows the text on Ctrl+L. */
  update(text: string): void;
}

export interface PromptStart {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PromptProvider {
  /** Shell variables to include in each context. Read again after every render,
   * so a provider can widen it, for example after loading its config. */
  readonly variables: readonly string[];
  /** Called once by createShell before the shell starts, never awaited. */
  prepare?(start: PromptStart): void;
  /** Return terminal text, or null to draw PS1. Should answer in a few ms. */
  render(context: PromptContext, live: PromptLive): string | null | PromiseLike<string | null>;
}
