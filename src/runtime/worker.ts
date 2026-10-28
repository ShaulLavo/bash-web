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
import { createExecutableQuery } from "./executable-query";
import { shellTerminalImports } from "./guest-imports";
import { createShellTerminals } from "./terminal-endpoints";
import { createTerminalAdmission, type TerminalAdmission } from "./terminal-admission";
import type { ShellWorkerData } from "./worker-launcher";

export interface ShellWorkerRequest extends RuntimeWorkerRequest {
  /** Only an interactive root owns page phase, not a child sharing its terminal. */
  terminal?: SharedArrayBuffer;
  terminalAdmission?: TerminalAdmission;
  memoryUsage?: SharedArrayBuffer;
  shellOutput?: SharedArrayBuffer;
}
export function shellExecutor(request: ShellWorkerRequest): WorkerExecutor<ShellWorkerRequest> {
  const data = request.runtimeProcess?.data as ShellWorkerData | undefined;
  const terminal = request.terminal ?? request.shellOutput ?? data?.shellTerminal;
  const admission =
    request.terminalAdmission ?? data?.terminalAdmission ?? createTerminalAdmission();
  const executableQuery = createExecutableQuery();
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
  const terminals = createShellTerminals(request, terminal, admission, bridge, () => checkActive());
  if (request.terminal && !terminals)
    throw new TypeError("Shell root requires terminal input metadata");
  const endpoint = (target: 0 | 1 | 2) => terminals?.resolve(target);
  return {
    stdio:
      request.terminal && terminals
        ? { 0: terminals.resolve(0), 1: terminals.resolve(1), 2: terminals.resolve(2) }
        : undefined,
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
        bash_web_executable: executableQuery.namespace,
        shell_terminal: {
          inherited_fd(index: number) {
            checkActive();
            return shell.inherited_fd(index);
          },
          columns() {
            checkActive();
            return terminals?.columns() ?? shell.columns();
          },
          phase(phase: number) {
            checkActive();
            shell.phase(phase);
            terminals?.phase(phase);
          },
        },
      };
    },
    resolveTerminal: endpoint,
    spawnData: () => ({
      ...terminals?.metadata(),
      shellTerminal: terminal,
      terminalAdmission: createTerminalAdmission(),
    }),
    beforeBindings({ wasi }) {
      if (!request.terminal) for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
    imports(imports, { wasi }) {
      if (imports.bash_web_executable) executableQuery.bind(wasi);
      // Sample the guest's allocation at host boundaries without retaining any guest
      // memory view across memory.grow. This telemetry is not an allocation quota.
      if (!sample && !bridge && !terminals) return;
      for (const namespace of Object.values(imports))
        for (const [name, value] of Object.entries(namespace)) {
          if (typeof value === "function")
            namespace[name] = (...args: number[]) => {
              sampleMemory();
              terminals?.prepare();
              return value(...args);
            };
        }
    },
    instantiated({ instance }) {
      memory =
        instance.exports.memory instanceof WebAssembly.Memory ? instance.exports.memory : undefined;
      sampleMemory();
      terminals?.ready();
      if (bridge && memory) {
        Atomics.store(bridge.state, control.phase, 1);
        bridge.signal();
      }
    },
    beforeFinish() {
      sampleMemory();
      terminals?.dispose();
    },
    run: preview1Executor.run,
  };
}
const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<ShellWorkerRequest>) => Promise<void>;
};
host.onmessage = (event) => bootstrap(event.data, shellExecutor(event.data));
