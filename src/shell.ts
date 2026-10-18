// Adapted from brush-web src/shell.ts at a2a4e96. The public facade accepts Waffle's
// exact Runtime, not a shell-specific runtime interface or a second service owner.
import type { Runtime } from "waffle";
import { SharedBridge } from "./bridge";
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
  /** Guest and worker asset URLs; bundlers can supply their emitted URLs explicitly. */
  wasmUrl?: string | URL;
  workerUrl?: string | URL;
  terminal?: SharedBridge;
  /** Cancels pending startup only; a resolved shell is stopped with dispose(). */
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  /** Omit for the persistent interactive editor. */
  script?: string;
}
export interface Shell {
  readonly terminal: SharedBridge;
  readonly process: RuntimeProcess;
  readonly done: Promise<RuntimeExit>;
  interrupt(): void;
  dispose(): Promise<void>;
  diagnostics(): ReturnType<typeof runtimeSnapshot>;
}
export async function createShell(options: ShellOptions): Promise<Shell> {
  const terminal = options.terminal ?? new SharedBridge();
  const process = await startShell(options, terminal);
  return {
    terminal,
    process,
    done: process.done,
    // The shell handles SIGINT and forwards only its foreground job.
    interrupt: () => process.signal(2),
    dispose: () => process.dispose(),
    diagnostics: () => runtimeSnapshot(options.runtime),
  };
}
