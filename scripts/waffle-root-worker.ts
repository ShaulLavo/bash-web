// Compatibility-instrument root only. Waffle's real bootstrap and runtime_proc, but the
// root keeps Waffle's default stdio: empty stdin, raw fd 1 and fd 2 posted separately to
// the harness. Fixture children run in the separate child worker (child.mjs).
import { bootstrap, preview1Executor, type RuntimeWorkerRequest } from "waffle/browser/worker";
import { shellTerminalImports } from "../src/runtime/guest-imports";

// The oracle ran Bash with stdout and stderr on pipes and stdin on /dev/null. Waffle's
// default stdio is transferable only as a terminal description, so the harness reports
// the oracle's kinds for exactly those three descriptions (and their duplicates). Any
// other descriptor keeps Waffle's own answer.
const PIPE = 1;
const OTHER = 0;
const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
host.onmessage = (event) => {
  const reported = new Map<object, number>();
  let resourceOf: (fd: number) => object | undefined = () => undefined;
  return bootstrap(event.data, {
    namespaces: () => ({ shell_terminal: shellTerminalImports() }),
    beforeBindings({ wasi }) {
      resourceOf = (fd) => wasi.descriptors.get(fd)?.resource;
      for (const [fd, kind] of [
        [0, OTHER],
        [1, PIPE],
        [2, PIPE],
      ] as const) {
        const resource = resourceOf(fd);
        if (resource) reported.set(resource, kind);
      }
    },
    imports(imports) {
      const proc = imports.runtime_proc as Record<string, unknown> | undefined;
      const original = proc?.fd_kind;
      if (!proc || typeof original !== "function") return;
      proc.fd_kind = (fd: number) => {
        const resource = resourceOf(fd >>> 0);
        return (resource && reported.get(resource)) ?? original(fd);
      };
    },
    run: preview1Executor.run,
  });
};
