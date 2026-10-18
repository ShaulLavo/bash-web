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
  async function disposeLease() {
    // Cleanup must run even after installation fails; propagate that failure afterward.
    await Promise.allSettled([ready]);
    // Start storage cancellation and adapter cleanup together: either can await storage.
    const cleanup = await Promise.allSettled([
      runtime.dispose(),
      Promise.resolve().then(() => installed?.dispose()),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Bun runtime cleanup failed");
    await ready;
  }
  let disposing: Promise<void> | undefined;
  return { runtime, ready, dispose: () => (disposing ??= disposeLease()) };
}
