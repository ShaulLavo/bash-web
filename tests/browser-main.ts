// Acceptance/demo composition. Bun's public async installer and worker exports exist.
// Bun cases stay disabled pending a verified Bun package, shared Waffle commit, and
// matching receipted guest. Then compose createBunRuntimeLease with that installer
// and workerUrl from "bun-wasm/worker?worker&url". No old guest is substituted.
import { createRuntime, type SharedFilesystemOptions } from "waffle";
import { withVfsImplementation } from "../node_modules/waffle/fs/vfs-internal.ts";
import { mountBrowser, type BrowserRuntimeLease } from "../src/browser/main";
import { registerTestPrograms } from "./helpers/test-programs";
import { installCat } from "../src/utilities/cat";
import { installGrep } from "../src/utilities/grep";
import { installHead } from "../src/utilities/head";
import { installMkdir } from "../src/utilities/mkdir";
import { installRg } from "../src/utilities/rg";
import { rgFiles } from "./helpers/rg-fixtures";
import { installLs } from "../src/utilities/ls";
import { installSeq } from "../src/utilities/seq";
import { installWc } from "../src/utilities/wc";
import { installTail } from "../src/utilities/tail";
import filesystemWorkerUrl from "../.build/browser/fs-worker.js?url";

declare global {
  interface Window {
    rgTest?: {
      readFile(path: string): Promise<string | undefined>;
      writeFile(path: string, text: string): Promise<void>;
    };
  }
}

async function prepareRg(runtime: ReturnType<typeof createRuntime>): Promise<void> {
  await installRg(runtime);
  const directory = "/home/guest/rg-fixture";
  const encoder = new TextEncoder();
  for (const [name, text] of Object.entries(rgFiles)) {
    const path = `${directory}/${name}`;
    await runtime.filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
    await runtime.filesystem.writeFile(path, encoder.encode(text));
  }
  await runtime.filesystem.drain();
  window.rgTest = {
    async readFile(path) {
      const bytes = await runtime.filesystem.readFile(path);
      return bytes && new TextDecoder().decode(bytes);
    },
    async writeFile(path, text) {
      await runtime.filesystem.writeFile(path, encoder.encode(text));
      await runtime.filesystem.drain();
    },
  };
}

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
    // External commands are add-ons: this composition selects these utilities. Each one's
    // program is fetched only when the shell first starts it.
    const ready = Promise.all([
      registerTestPrograms(runtime, registration.signal, onStartupStage),
      query.get("test") === "1" && query.get("rg") === "1" ? prepareRg(runtime) : undefined,
      Promise.all(
        [
          installCat,
          installGrep,
          installHead,
          installLs,
          installMkdir,
          installSeq,
          installTail,
          installWc,
        ].map((install) => install(runtime)),
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
