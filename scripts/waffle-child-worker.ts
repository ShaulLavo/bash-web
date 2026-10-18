import { bootstrap, preview1Executor, type RuntimeWorkerRequest } from "waffle/browser/worker";
import { shellTerminalImports } from "../src/runtime/guest-imports";

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
host.onmessage = (event) =>
  bootstrap(event.data, {
    namespaces: () => ({
      shell_terminal: shellTerminalImports(
        undefined,
        event.data.runtimeProcess?.bindings.map((binding) => binding.fd) ?? [],
      ),
    }),
    beforeBindings({ wasi }) {
      for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
    run: preview1Executor.run,
  });
