// Acceptance/demo composition. Everyday programs come from Waffle's base package.
import { installBase } from "waffle-base";
import { createRuntime, type Runtime, type SharedFilesystemOptions } from "waffle";
import { withVfsImplementation } from "../node_modules/waffle/fs/vfs-internal.ts";
import { mountBrowser, type BrowserRuntimeLease } from "../src/browser/main";
import { genericProgramLauncher } from "../src/runtime/program-launcher";
import { installShellCommands } from "../src/shell-commands";
import { registerTestPrograms } from "./helpers/test-programs";
import { rgFiles } from "../node_modules/waffle-ripgrep/tests/helpers/rg-fixtures.ts";
import filesystemWorkerUrl from "../.build/browser/fs-worker.js?url";
import programWorkerUrl from "../node_modules/waffle/browser/preview1-worker.ts?worker&url";

declare global {
  interface Window {
    readSortUniqOutput?: () => Promise<{ stdout: number[]; stderrPresent: boolean }>;
    rgTest?: {
      readFile(path: string): Promise<string | undefined>;
      writeFile(path: string, text: string): Promise<void>;
    };
  }
}

async function readSortUniqOutput(runtime: Runtime) {
  const stdout = await runtime.filesystem.readFile("/tmp/sort-uniq-output");
  const stderr = await runtime.filesystem.readFile("/tmp/sort-uniq-error");
  if (!stdout || !stderr) throw new Error("Missing sort/uniq observation output files");
  return { stdout: Array.from(stdout), stderrPresent: stderr.length > 0 };
}

async function prepareRg(runtime: ReturnType<typeof createRuntime>): Promise<void> {
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
    if (query.get("test") === "1") window.readSortUniqOutput = () => readSortUniqOutput(runtime);
    if (
      query.get("test") === "1" &&
      query.get("storage") === "opfs" &&
      runtime.filesystem.vfs.implementation !== "opfs-memory"
    )
      throw new Error("OPFS conformance selector did not reach the runtime");
    const registration = new AbortController();
    // Base registers every everyday family lazily on the caller's one runtime.
    const ready = Promise.all([
      registerTestPrograms(runtime, registration.signal, onStartupStage),
      query.get("test") === "1" && query.get("rg") === "1" ? prepareRg(runtime) : undefined,
      installShellCommands(runtime),
      installBase(runtime, { launcher: genericProgramLauncher(programWorkerUrl) }),
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
