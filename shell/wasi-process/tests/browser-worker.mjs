import { bootstrap, preview1Executor } from "waffle/browser/worker";

globalThis.onmessage = ({ data }) =>
  bootstrap(data, {
    ...preview1Executor,
    // Match Shell's child policy: only explicit inherited bindings remain open.
    beforeBindings({ wasi }) {
      for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
    imports(imports) {
      const mode = data.args[1];
      const operation = mode === "review-drop-child" ? "kill_job" : "access_cancel";
      if (mode !== "review-drop-child" && mode !== "review-drop-access") return;
      const original = imports.runtime_proc[operation];
      imports.runtime_proc[operation] = (...args) => {
        original(...args);
        return -29;
      };
      const fdWrite = imports.wasi_snapshot_preview1.fd_write;
      imports.wasi_snapshot_preview1.fd_write = (...args) =>
        args[0] === 2 ? 29 : fdWrite(...args);
    },
  });
