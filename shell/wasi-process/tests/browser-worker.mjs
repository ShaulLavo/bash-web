import { bootstrap, preview1Executor } from "waffle/browser/worker";

function delayedPollControl(imports, buffer) {
  if (!buffer) return;
  const control = new Int32Array(buffer);
  const wait = imports.runtime_proc.wait_job;
  imports.runtime_proc.wait_job = (...args) => {
    if (args[1] === 2) {
      Atomics.add(control, 1, 1);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    }
    return wait(...args);
  };
}

function fixtureNamespaces(buffer) {
  return { fixture_control: { release_fence: () => requestFenceRelease(buffer) } };
}

function requestFenceRelease(buffer) {
  if (!buffer) throw new Error("fixture has no delayed fence controller");
  const control = new Int32Array(buffer);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

globalThis.onmessage = ({ data }) =>
  bootstrap(data, {
    ...preview1Executor,
    namespaces: () => fixtureNamespaces(data.testFence),
    // Match Shell's child policy: only explicit inherited bindings remain open.
    beforeBindings({ wasi }) {
      for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
    },
    imports(imports) {
      delayedPollControl(imports, data.testFence);
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
