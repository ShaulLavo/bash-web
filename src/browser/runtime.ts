import { createRuntime, VfsError, type Runtime, type VfsMode } from "waffle";
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
    onProcessAdmission(event) {
      console.log("process-admission", JSON.stringify(event));
    },
  });
  return { runtime, ready: Promise.resolve(), dispose: () => runtime.dispose() };
}
