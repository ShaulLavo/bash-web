// Own-shell guest policy, adapted from brush-web src/runtime/worker.ts at a2a4e96.
// The former bootstrap derived from bun-wasm web/src/worker.ts at
// 8d3d416aa9cb23718ed3487a33d0b06e8e373672; process/FS/descriptor services now
// remain entirely in Waffle's published browser bootstrap.
import {
  bootstrap,
  preview1Executor,
  type WorkerExecutor,
  type RuntimeWorkerRequest,
} from "waffle/browser/worker";
import { SharedBridge, control } from "../bridge";
import { shellTerminalImports } from "./guest-imports";
import { createBridgeTerminal } from "./runtime-terminals";
import { createTerminalAdmission, type TerminalAdmission } from "./terminal-admission";
import type { ShellWorkerData } from "./worker-launcher";

export interface ShellWorkerRequest extends RuntimeWorkerRequest {
  /** Only an interactive root owns page phase, not a child sharing its terminal. */
  terminal?: SharedArrayBuffer;
  terminalAdmission?: TerminalAdmission;
  memoryUsage?: SharedArrayBuffer;
}
export function shellExecutor(request: ShellWorkerRequest): WorkerExecutor<ShellWorkerRequest> {
  const data = request.runtimeProcess?.data as ShellWorkerData | undefined;
  const terminal = request.terminal ?? data?.shellTerminal;
  const admission =
    request.terminalAdmission ?? data?.terminalAdmission ?? createTerminalAdmission();
  let checkActive = () => {};
  let memory: WebAssembly.Memory | undefined;
  const bridge = request.terminal ? new SharedBridge(request.terminal) : undefined;
  const sample = request.memoryUsage ? new BigInt64Array(request.memoryUsage) : undefined;
  const sampleMemory = () => {
    if (!memory) return;
    const bytes = memory.buffer.byteLength;
    if (sample) Atomics.store(sample, 0, BigInt(bytes));
    if (bridge) Atomics.store(bridge.state, control.memory, bytes);
  };
  const endpoint = (target: 0 | 1 | 2) => {
    if (!terminal) throw new Error("Shared terminal descriptor has no admitted destination");
    return createBridgeTerminal(terminal, target, () => checkActive(), admission);
  };
  return {
    stdio: request.terminal ? { 0: endpoint(0), 1: endpoint(1), 2: endpoint(2) } : undefined,
    setup(context) {
      checkActive = context.checkActive;
    },
    namespaces() {
      const shell = shellTerminalImports(
        request.terminal,
        request.terminal
          ? [0, 1, 2]
          : request.runtimeProcess?.bindings.map((binding) => binding.fd),
      );
      return {
        shell_terminal: {
          inherited_fd(index: number) {
            checkActive();
            return shell.inherited_fd(index);
          },
          columns() {
            checkActive();
            return shell.columns();
          },
          phase(phase: number) {
            checkActive();
            shell.phase(phase);
          },
        },
      };
    },
    ...(terminal ? { resolveTerminal: endpoint } : {}),
    spawnData: () => ({ shellTerminal: terminal, terminalAdmission: createTerminalAdmission() }),
    beforeBindings({ wasi }) {
      if (!request.terminal) for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
    imports(imports) {
      // Sample the guest's allocation at host boundaries without retaining any guest
      // memory view across memory.grow. This telemetry is not an allocation quota.
      if (!sample && !bridge) return;
      for (const namespace of Object.values(imports))
        for (const [name, value] of Object.entries(namespace)) {
          if (typeof value === "function")
            namespace[name] = (...args: number[]) => {
              sampleMemory();
              return value(...args);
            };
        }
    },
    instantiated({ instance }) {
      memory =
        instance.exports.memory instanceof WebAssembly.Memory ? instance.exports.memory : undefined;
      sampleMemory();
      if (bridge && memory) {
        Atomics.store(bridge.state, control.phase, 1);
        bridge.signal();
      }
    },
    beforeFinish: sampleMemory,
    run: preview1Executor.run,
  };
}
const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<ShellWorkerRequest>) => Promise<void>;
};
host.onmessage = (event) => bootstrap(event.data, shellExecutor(event.data));
