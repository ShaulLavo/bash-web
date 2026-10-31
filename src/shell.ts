// Adapted from brush-web src/shell.ts at a2a4e96. The public facade accepts Waffle's
// exact Runtime, not a shell-specific runtime interface or a second service owner.
import type { Runtime } from "waffle";
import type { StartupObserver } from "./runtime/startup-diagnostics";
import { SharedBridge, type ShellPrompt } from "./bridge";
import { waitForPrompt, type PromptWaitOptions } from "./shell-prompt";
import { runtimeSnapshot } from "./runtime/diagnostics";
import { startShell } from "./runtime/shell-host";

export interface RuntimeExit {
  code: number;
  error?: string;
}
export interface RuntimeProcess {
  readonly pid: number;
  readonly wasmBytes: number;
  readonly done: Promise<RuntimeExit>;
  signal(signal: 2 | 9): void;
  dispose(): Promise<void>;
}
export interface ShellOptions {
  /** The embedding page's one shared runtime. Disposing a shell does not dispose it. */
  runtime: Runtime;
  /** Passive startup measurement. Must not abort or start/stop the shell or runtime.
   * Control reentry is unsupported, as in Waffle's docs/runtime-startup.md. */
  onStartupStage?: StartupObserver;
  /** Guest and worker asset URLs; bundlers can supply their emitted URLs explicitly. */
  wasmUrl?: string | URL;
  workerUrl?: string | URL;
  terminal?: SharedBridge;
  /** Cancels pending startup only; a resolved shell is stopped with dispose(). */
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  /** Editing only. Bash commands and the default Bash editing mode stay unchanged. */
  lineEditor?: { mode: "bash" | "zsh" };
  /** Omit for the persistent interactive editor. */
  script?: string;
}
export interface Shell {
  readonly terminal: SharedBridge;
  readonly process: RuntimeProcess;
  readonly done: Promise<RuntimeExit>;
  waitForPrompt(options?: PromptWaitOptions): Promise<ShellPrompt>;
  interrupt(): void;
  dispose(): Promise<void>;
  diagnostics(): ReturnType<typeof runtimeSnapshot>;
}
export async function createShell(options: ShellOptions): Promise<Shell> {
  const terminal = options.terminal ?? new SharedBridge();
  const process = await startShell(options, terminal);
  const lifetime = new AbortController();
  const stopWaiting = () => lifetime.abort(new Error("Shell closed before the next prompt"));
  void process.done.then(stopWaiting, stopWaiting);
  return {
    terminal,
    process,
    done: process.done,
    waitForPrompt: ({ signal, after }: PromptWaitOptions = {}) =>
      waitForPrompt(terminal, {
        after,
        signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      }),
    // The shell handles SIGINT and forwards only its foreground job.
    interrupt: () => process.signal(2),
    dispose: () => {
      stopWaiting();
      return process.dispose();
    },
    diagnostics: () => runtimeSnapshot(options.runtime),
  };
}

export type { ShellPrompt } from "./bridge";
export type { PromptWaitOptions } from "./shell-prompt";
