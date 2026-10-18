// Expected public bun-wasm integration contract. This fixture is not enabled until
// the root package and bun-wasm/worker export are published against our Waffle peer.
// No Bun implementation or internal ABI is copied into this repository.
import { createRuntime, type Runtime } from "waffle";
import type { BrowserRuntimeLease } from "../../src/browser/main";

export type InstallBunAdapters = (
  runtime: Runtime,
  options: { workerUrl: string; wasmUrl?: string },
) => { dispose(): void | Promise<void> };

export function createBunRuntimeLease(
  installBunAdapters: InstallBunAdapters,
  workerUrl: string,
): BrowserRuntimeLease {
  const runtime = createRuntime();
  // The published installer selects and verifies its matching guest by default.
  // Do not reuse the old independently pinned guest without compatibility evidence.
  let installed: ReturnType<InstallBunAdapters> | undefined;
  const ready = Promise.resolve().then(() => {
    installed = installBunAdapters(runtime, { workerUrl });
  });
  let disposing: Promise<void> | undefined;
  return {
    runtime,
    ready,
    dispose: () =>
      (disposing ??= (async () => {
        try {
          await ready;
        } finally {
          try {
            await installed?.dispose();
          } finally {
            await runtime.dispose();
          }
        }
      })()),
  };
}
