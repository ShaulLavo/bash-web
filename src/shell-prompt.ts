import { control, type SharedBridge, type ShellPrompt } from "./bridge";

export interface PromptWaitOptions {
  /** Last consumed generation. Omit or use 0n to wait for startup. */
  after?: bigint;
  /** Cancels this wait without interrupting the shell. */
  signal?: AbortSignal;
}

export async function waitForPrompt(
  terminal: SharedBridge,
  { after = 0n, signal }: PromptWaitOptions = {},
): Promise<ShellPrompt> {
  if (after < 0n) throw new RangeError("Prompt generation must be nonnegative");
  const abort = () => terminal.signal();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await nextPrompt(terminal, after, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function nextPrompt(
  terminal: SharedBridge,
  after: bigint,
  signal?: AbortSignal,
): Promise<ShellPrompt> {
  while (true) {
    const wake = Atomics.load(terminal.state, control.wake);
    signal?.throwIfAborted();
    if (terminal.closed() || Atomics.load(terminal.state, control.phase) >= 3)
      throw new Error("Shell closed before the next prompt");
    const prompt = terminal.readPrompt();
    if (prompt && prompt.generation > after) return prompt;
    await Atomics.waitAsync(terminal.state, control.wake, wake).value;
  }
}
