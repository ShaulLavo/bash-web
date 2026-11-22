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

function readPromptBytes(
  read: (chunks: readonly Uint8Array[]) => number,
  chunks: readonly Uint8Array[],
  byte: Uint8Array,
  raw: boolean,
): number {
  const output = chunks[0];
  if (chunks.length !== 1 || !output || output.length <= 1) return read(chunks);
  if (!raw) return read([output.subarray(0, 1)]);
  const single = [byte];
  // Waffle's raw read cannot stop at a delimiter. Keep the unread suffix in
  // the shared queue so a command or foreground process can read it.
  for (let index = 0; index < output.length; index++) {
    const count = read(single);
    if (count <= 0) return index || count;
    const value = byte[0]!;
    output[index] = value;
    if (value === 3 || value === 4 || value === 10 || value === 13) return index + 1;
  }
  return output.length;
}

export function createShellTerminals(
  request: Pick<RuntimeWorkerRequest, "runtimeProcess">,
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
  const display = new SharedBridge(output);
  // Waffle checks liveness outside policy callbacks. Admission still fences output;
  // throwing here after a member dies would close the shared terminal session.
  const endpoints = {
    1: createBridgeTerminal(output, 1, undefined, admission),
    2: createBridgeTerminal(output, 2, undefined, admission),
  };
  const base = createTerminalInputPolicy({
    input,
    tryWrite: (target, chunks) => endpoints[target].tryWrite!(chunks),
    outputReadiness: (target) => ({ writable: endpoints[target].readiness().writable }),
  });
  const inPrompt = () => root !== undefined && Atomics.load(root.state, control.phase) === 1;
  const blocked = (turn: Parameters<typeof base.tryRead>[0]) => {
    if (!root) return false;
    const cancel = Atomics.load(root.state, control.cancel);
    if (cancel !== 1 || turn.mode !== "raw" || !inPrompt()) return cancel !== 0;
    root.acknowledgeInputDiscard();
    return root.cancelled();
  };
  const byte = new Uint8Array(1);
  const policy = root
    ? {
        ...base,
        tryRead(turn: Parameters<typeof base.tryRead>[0], chunks: readonly Uint8Array[]) {
          if (blocked(turn)) return -6;
          if (inPrompt())
            return readPromptBytes(
              (destination) => base.tryRead(turn, destination),
              chunks,
              byte,
              turn.mode === "raw",
            );
          return base.tryRead(turn, chunks);
        },
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
    const cancel = root ? Atomics.load(root.state, control.cancel) : 0;
    if (cancel === 2 || (!pendingMode && cancel === 0)) return;
    const phase = root ? Atomics.load(root.state, control.phase) : 2;
    if (cancel !== 0 && phase !== 1) return;
    if (cancel !== 0) pendingMode = "raw";
    if (!pendingMode) return;
    const snapshot = controller.snapshot();
    if (snapshot.kind === "error") return;
    const changed = controller.setMode({ expected: snapshot.value.selection, mode: pendingMode });
    if (changed.kind === "error") return;
    pendingMode = undefined;
    if (root && cancel !== 0) root.acknowledgeInputDiscard();
  };
  // The shell can resume before the page retires an exited raw foreground group.
  // Reassert its input mode at the read boundary, not at unrelated host imports.
  const prepareInput = () => {
    const phase = root ? Atomics.load(root.state, control.phase) : undefined;
    if (phase === 1 || phase === 2) pendingMode = phase === 1 ? "raw" : "cooked";
    prepare();
  };
  const resolve = (target: 0 | 1 | 2) => {
    const endpoint = attachment.resolve(target);
    if (!root || target !== 0) return endpoint;
    const readiness = endpoint.readiness.bind(endpoint);
    const tryRead = endpoint.tryRead!.bind(endpoint);
    endpoint.readiness = () => {
      prepareInput();
      return readiness();
    };
    endpoint.tryRead = (chunks) => {
      prepareInput();
      return tryRead(chunks);
    };
    return endpoint;
  };
  return {
    resolve,
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
      return Math.max(2, Atomics.load(display.state, control.cols));
    },
    rows() {
      return Math.max(2, Atomics.load(display.state, control.rows));
    },
  };
}
