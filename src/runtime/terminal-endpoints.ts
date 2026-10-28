import {
  attachTerminal,
  attachTerminalInput,
  createTerminalInputPolicy,
  terminalControls,
  type TerminalMode,
} from "waffle/browser/runtime-terminals";
import type { RuntimeWorkerRequest } from "waffle/browser/worker";
import { SharedBridge, control } from "../bridge";
import { createBridgeTerminal } from "./runtime-terminals";
import type { TerminalAdmission } from "./terminal-admission";

export function createShellTerminals(
  request: RuntimeWorkerRequest,
  output: SharedArrayBuffer | undefined,
  admission: TerminalAdmission,
  root: SharedBridge | undefined,
  checkActive: () => void,
) {
  const data: unknown = request.runtimeProcess?.data;
  if (!data || typeof data !== "object") return;
  const hasContext = "terminalContext" in data;
  const hasInput = "terminalInput" in data;
  if (!hasContext && !hasInput) return;
  if (!hasContext || !hasInput || !(data.terminalInput instanceof SharedArrayBuffer))
    throw new TypeError("Incomplete terminal input metadata");
  if (!request.runtimeProcess || !output)
    throw new TypeError("Terminal input has no owned shell output destination");
  const input = attachTerminalInput(data.terminalInput);
  const endpoints = {
    1: createBridgeTerminal(output, 1, checkActive, admission),
    2: createBridgeTerminal(output, 2, checkActive, admission),
  };
  const base = createTerminalInputPolicy({
    input,
    tryWrite: (target, chunks) => endpoints[target].tryWrite!(chunks),
    outputReadiness: (target) => ({ writable: endpoints[target].readiness().writable }),
  });
  const blocked = (turn: Parameters<typeof base.tryRead>[0]) => {
    if (root && turn.mode === "raw" && Atomics.load(root.state, control.phase) === 1)
      root.acknowledgeInputDiscard();
    return !!root?.cancelled();
  };
  const policy = root
    ? {
        ...base,
        tryRead: (turn: Parameters<typeof base.tryRead>[0], chunks: readonly Uint8Array[]) =>
          blocked(turn) ? -6 : base.tryRead(turn, chunks),
        inputReadiness: (turn: Parameters<typeof base.inputReadiness>[0]) =>
          blocked(turn) ? { readable: false, nbytes: 0 } : base.inputReadiness(turn),
      }
    : base;
  const attachment = attachTerminal({
    context: data.terminalContext,
    process: request.runtimeProcess,
    checkActive,
    policy,
  });
  const controller = terminalControls(attachment.resolve(0))!;
  let pendingMode: TerminalMode | undefined = "raw";
  const prepare = () => {
    if (root && Atomics.load(root.state, control.cancel) === 2) return;
    const phase = root ? Atomics.load(root.state, control.phase) : 2;
    if (root?.cancelled() && phase !== 1) return;
    if (root && phase === 1) pendingMode = "raw";
    if (!pendingMode) return;
    const snapshot = controller.snapshot();
    if (snapshot.kind === "error") return;
    const changed = controller.setMode({ expected: snapshot.value.selection, mode: pendingMode });
    if (changed.kind === "error") return;
    pendingMode = undefined;
    if (root && phase === 1) root.acknowledgeInputDiscard();
  };
  return {
    resolve: (target: 0 | 1 | 2) => attachment.resolve(target),
    prepare,
    phase(phase: number) {
      if (phase === 1 || phase === 2) pendingMode = phase === 1 ? "raw" : "cooked";
      prepare();
    },
    metadata: () => ({ terminalContext: attachment.inherit(), terminalInput: input.buffer }),
    ready: () => {
      const result = attachment.ready();
      if (result.kind === "error") throw new Error(`Terminal attachment failed: ${result.code}`);
      prepare();
    },
    dispose: () => attachment.dispose(),
    columns() {
      const snapshot = controller.snapshot();
      return snapshot.kind === "ok" ? snapshot.value.geometry.columns : 80;
    },
  };
}
