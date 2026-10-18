// Compatibility-instrument root only. Waffle's real bootstrap and runtime_proc, but the
// root keeps Waffle's default stdio: empty stdin, raw fd 1 and fd 2 posted separately to
// the harness. Children use the production shell worker (shell.mjs) unchanged.
import { bootstrap, preview1Executor, type RuntimeWorkerRequest } from "waffle/browser/worker";
import { shellTerminalImports } from "../src/runtime/guest-imports";

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
host.onmessage = (event) =>
  bootstrap(event.data, {
    namespaces: () => ({ shell_terminal: shellTerminalImports() }),
    run: preview1Executor.run,
  });
