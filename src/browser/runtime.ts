import { createRuntime, VfsError, type Runtime, type VfsMode } from "waffle";
import type { StartupObserver } from "../runtime/startup-diagnostics";
import type { StorageStartup } from "../runtime/storage";
import { DEFAULT_WORKSPACE } from "./start-fresh";

export type BrowserRuntimeLease = {
  runtime: Runtime;
  ready: Promise<void>;
  /**
   * The saved IndexedDB workspace this lease opened in fast mode. Set it so the demo can offer
   * Start fresh when that workspace cannot be read. Start fresh checks and deletes IndexedDB
   * only, so leave it unset for OPFS storage and for a runtime the page must not delete.
   */
  workspace?: string;
  dispose(): Promise<void>;
};
export type BrowserHostOptions =
  | { runtime: Runtime; acquireRuntime?: never; mode?: never; storageStartup?: StorageStartup }
  | {
      runtime?: never;
      storageStartup?: never;
      acquireRuntime: (onStartupStage?: StartupObserver) => BrowserRuntimeLease;
      mode?: never;
    }
  | {
      runtime?: never;
      acquireRuntime?: never;
      mode?: Extract<VfsMode, "fast" | "memory">;
      storageStartup?: never;
    };

type RuntimeCreation = {
  workerURL: string;
  search: string;
  onStartupStage?: StartupObserver;
};

export function acquireBrowserRuntime(
  options: BrowserHostOptions,
  creation: RuntimeCreation,
): BrowserRuntimeLease {
  if (options.runtime)
    return { runtime: options.runtime, ready: Promise.resolve(), dispose: async () => {} };
  if (options.acquireRuntime) return options.acquireRuntime(creation.onStartupStage);
  const selected = options.mode;
  const mode =
    selected === undefined
      ? (new URLSearchParams(creation.search).get("mode") ?? "fast")
      : selected;
  if (mode !== "fast" && mode !== "memory")
    throw new VfsError("UNSUPPORTED_VFS", String(mode), `Unsupported VFS mode: ${String(mode)}`);
  const runtime = createRuntime({
    filesystem: { mode, workerURL: creation.workerURL },
    onStartupStage: creation.onStartupStage,
  });
  return {
    runtime,
    ready: Promise.resolve(),
    workspace: mode === "fast" ? DEFAULT_WORKSPACE : undefined,
    dispose: () => runtime.dispose(),
  };
}
