import { workerData } from "node:worker_threads";
import {
  attachTerminal,
  createTerminalInputPolicy,
  type TerminalContext,
} from "waffle/browser/runtime-terminals";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

const data: {
  context: TerminalContext;
  process: WorkerProcessTransport;
  input: SharedArrayBuffer;
  flag: SharedArrayBuffer;
} = workerData;
const cells = new Int32Array(data.flag);
const base = createTerminalInputPolicy({ input: data.input });
const attachment = attachTerminal({
  context: data.context,
  process: data.process,
  checkActive() {},
  policy: {
    ...base,
    tryRead(turn, chunks) {
      Atomics.store(cells, 0, 1);
      Atomics.notify(cells, 0);
      Atomics.wait(cells, 1, 0);
      return base.tryRead(turn, chunks);
    },
  },
});
try {
  const count = attachment.resolve(0).tryRead!([new Uint8Array(1)]);
  Atomics.store(cells, 2, count);
} finally {
  attachment.dispose();
  Atomics.store(cells, 3, 1);
  Atomics.notify(cells, 3);
}
