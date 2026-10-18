// Acceptance/demo composition. Bun cases remain individually pending until bun-wasm
// publishes installBunAdapters(runtime, { workerUrl }) and bun-wasm/worker.
// Then compose createBunRuntimeLease from ./helpers/bun-fixture using that installer
// and import workerUrl from "bun-wasm/worker?worker&url". No old guest is substituted.
import { createRuntime, type SharedFilesystemOptions } from "waffle";
import { mountBrowser, type BrowserRuntimeLease } from "../src/browser/main";
import { registerTestPrograms } from "./helpers/test-programs";
import filesystemWorkerUrl from "../.build/browser/fs-worker.js?url";

function filesystemOptions(): SharedFilesystemOptions {
  const query = new URLSearchParams(location.search);
  const defaults = { workerURL: filesystemWorkerUrl };
  if (query.get("test") !== "1") return defaults;
  const name = query.get("workspace") ?? undefined;
  const whenBusy = query.get("whenBusy");
  if (query.get("storage") === "opfs") {
    if (whenBusy === "takeover") throw new TypeError('OPFS storage only supports whenBusy: "wait"');
    return { ...defaults, name, storage: "opfs" };
  }
  return {
    ...defaults,
    name,
    whenBusy: whenBusy === "wait" ? "wait" : undefined,
  };
}

mountBrowser({
  acquireRuntime(): BrowserRuntimeLease {
    const runtime = createRuntime({ filesystem: filesystemOptions() });
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
