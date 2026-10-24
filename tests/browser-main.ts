// Acceptance/demo composition. Bun cases remain individually pending until bun-wasm
// publishes installBunAdapters(runtime, { workerUrl }) and bun-wasm/worker.
// Then compose createBunRuntimeLease from ./helpers/bun-fixture using that installer
// and import workerUrl from "bun-wasm/worker?worker&url". No old guest is substituted.
import { createRuntime, type SharedFilesystemOptions } from "waffle";
import { withVfsImplementation } from "../node_modules/waffle/fs/vfs-internal.ts";
import { mountBrowser, type BrowserRuntimeLease } from "../src/browser/main";
import { registerTestPrograms } from "./helpers/test-programs";
import { installCat } from "../src/utilities/cat";
import { installGrep } from "../src/utilities/grep";
import { installMkdir } from "../src/utilities/mkdir";
import { installSeq } from "../src/utilities/seq";
import filesystemWorkerUrl from "../.build/browser/fs-worker.js?url";

function filesystemOptions(): SharedFilesystemOptions {
  const query = new URLSearchParams(location.search);
  const defaults = {
    mode: "fast",
    workerURL: filesystemWorkerUrl,
  } satisfies SharedFilesystemOptions;
  if (query.get("test") !== "1") return defaults;
  const name = query.get("workspace") ?? undefined;
  if (query.get("storage") === "safe") return { ...defaults, name, mode: "safe" };
  const whenBusy = query.get("whenBusy");
  if (query.get("storage") === "opfs") {
    if (whenBusy === "takeover") throw new TypeError('OPFS storage only supports whenBusy: "wait"');
    return withVfsImplementation("opfs-memory", { ...defaults, name, mode: "fast" });
  }
  return {
    ...defaults,
    name,
    whenBusy: whenBusy === "wait" ? "wait" : undefined,
  };
}

mountBrowser({
  acquireRuntime(onStartupStage): BrowserRuntimeLease {
    const runtime = createRuntime({ filesystem: filesystemOptions(), onStartupStage });
    const query = new URLSearchParams(location.search);
    if (
      query.get("test") === "1" &&
      query.get("storage") === "opfs" &&
      runtime.filesystem.vfs.implementation !== "opfs-memory"
    )
      throw new Error("OPFS conformance selector did not reach the runtime");
    const registration = new AbortController();
    // External commands are add-ons: this composition selects all four. Each one's
    // program is fetched only when the shell first starts it.
    const ready = Promise.all([
      registerTestPrograms(runtime, registration.signal, onStartupStage),
      Promise.all(
        [installCat, installGrep, installMkdir, installSeq].map((install) => install(runtime)),
      ),
    ]).then(() => {});
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
