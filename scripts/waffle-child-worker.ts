// Compatibility-instrument child programs (the oracle's argv.py and printenv.py
// fixtures). Waffle's real bootstrap, runtime_proc and descriptor transfer; the
// inherited descriptors come from the parent's bindings, and output inherited from
// the root reaches the harness through Waffle's raw output path, not a terminal.
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
