import { bootstrap, type RuntimeWorkerRequest } from "waffle/browser/worker";
import { programExecutor } from "../src/runtime/program-worker";
const host = globalThis as unknown as { onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void> };
host.onmessage = event => bootstrap(event.data, programExecutor(event.data, true));
