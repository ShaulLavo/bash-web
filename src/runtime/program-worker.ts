// External cooperative guests use Waffle's real process, filesystem and descriptor bootstrap.
import { bootstrap, preview1Executor, type RuntimeWorkerRequest, type WorkerExecutor } from "waffle/browser/worker";
import { shellTerminalImports } from "./guest-imports";

export function programExecutor(request: RuntimeWorkerRequest, root = false): WorkerExecutor<RuntimeWorkerRequest> {
  return {
    namespaces: () => ({ shell_terminal: shellTerminalImports(undefined, root ? [0, 1, 2] : request.runtimeProcess?.bindings.map(binding => binding.fd) ?? []) }),
    beforeBindings({ wasi }) {
      if (!root) for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
    run: preview1Executor.run,
  };
}
const host = globalThis as unknown as { onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void> };
host.onmessage = event => bootstrap(event.data, programExecutor(event.data));
