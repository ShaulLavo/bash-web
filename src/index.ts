export { createShell } from "./shell";
export type {
  RuntimeExit,
  RuntimeProcess,
  Shell,
  ShellOptions,
  ShellPrompt,
  PromptWaitOptions,
} from "./shell";
export type { PromptContext, PromptLive, PromptProvider, PromptStart } from "./prompt-hook";
export { installShellCommands, UtilityConflictError } from "./shell-commands";
export type { ShellCommandOptions, ShellCommandsInstallation } from "./shell-commands";
export { SharedBridge, control, INPUT_CAPACITY, OUTPUT_CAPACITY } from "./bridge";
export { TerminalNewlines } from "./shell-terminal-output";
export { runtimeSnapshot } from "./runtime/diagnostics";
export type { StartupObserver, StartupStage, StartupSnapshot } from "./runtime/startup-diagnostics";
