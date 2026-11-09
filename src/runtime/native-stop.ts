import type { ProcessHandle } from "waffle/proc/types";
import { captureNativeReturn } from "waffle/proc/observation";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

/** Capture before admission or an embedding hook can collect the process row. */
export function captureShellWorkerStop(transport: WorkerProcessTransport) {
  const returned = captureNativeReturn(transport);
  return (worker?: Pick<ProcessHandle, "terminate">): void | Promise<void> => {
    const stopping = worker?.terminate();
    if (stopping) return stopping.then(returned);
    returned();
  };
}
