import { bootstrap, preview1Executor } from "waffle/browser/worker";

globalThis.onmessage = ({ data }) =>
  bootstrap(data, {
    ...preview1Executor,
    // Match Shell's child policy: only explicit inherited bindings remain open.
    beforeBindings({ wasi }) {
      for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
  });
