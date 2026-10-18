export { createShell } from "./shell";
export type { RuntimeExit, RuntimeProcess, Shell, ShellOptions } from "./shell";
export { SharedBridge, control, INPUT_CAPACITY, OUTPUT_CAPACITY } from "./bridge";
export { TerminalNewlines } from "./shell-terminal-output";
export { runtimeSnapshot } from "./runtime/diagnostics";
export type { StartupObserver, StartupStage, StartupSnapshot } from "./runtime/startup-diagnostics";
