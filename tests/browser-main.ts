// Acceptance/demo composition. Bun cases remain individually pending until bun-wasm
// publishes installBunAdapters(runtime, { workerUrl }) and bun-wasm/worker.
// Compose the installer with the page-owned runtime and import workerUrl from
// "bun-wasm/worker?worker&url". No old guest is substituted.
import { createRuntime } from "waffle";
import { mountBrowser, type BrowserRuntimeLease } from "../src/browser/main";
import { registerTestPrograms } from "./helpers/test-programs";
import filesystemWorkerUrl from "../.build/browser/fs-worker.js?url";

mountBrowser({
  acquireRuntime(): BrowserRuntimeLease {
    const runtime = createRuntime({ filesystem: { workerURL: filesystemWorkerUrl } });
    const registration = new AbortController();
    const ready = registerTestPrograms(runtime, registration.signal);
    let disposing: Promise<void> | undefined;
    return {
      runtime,
      ready,
      dispose() {
        registration.abort(new Error("Test program registration was cancelled."));
        // The owner fences admitted filesystem work itself. Do not wait for a fetch
        // or compilation to settle before starting that teardown.
        return (disposing ??= runtime.dispose());
      },
    };
  },
});
