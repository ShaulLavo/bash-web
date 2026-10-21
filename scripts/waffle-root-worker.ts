import { bootstrap, preview1Executor, type RuntimeWorkerRequest } from "waffle/browser/worker";
import { shellTerminalImports } from "../src/runtime/guest-imports";

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
