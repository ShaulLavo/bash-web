import { createRuntime, type Runtime, type VfsMode } from "waffle";
import type { StartupObserver } from "../runtime/startup-diagnostics";
import type { StorageStartup } from "./storage";

export type BrowserRuntimeLease = {
  runtime: Runtime;
  ready: Promise<void>;
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
  const runtime = createRuntime({
    filesystem: { mode: "fast", workerURL: creation.workerURL },
    onStartupStage: creation.onStartupStage,
  });
  return { runtime, ready: Promise.resolve(), dispose: () => runtime.dispose() };
}
