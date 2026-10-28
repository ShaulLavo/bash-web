import { workerData } from "node:worker_threads";
import type { TerminalContext } from "waffle/browser/runtime-terminals";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

const data: {
  context: TerminalContext;
  process: WorkerProcessTransport;
  input: SharedArrayBuffer;
  flag: SharedArrayBuffer;
} = workerData;
const cells = new Int32Array(data.flag);
const compareExchange = Atomics.compareExchange;
let paused = false;
// Test-only interleaving: retain the actual CAS, without inspecting the opaque input header.
Atomics.compareExchange = new Proxy(compareExchange, {
  apply(target, receiver, args: unknown[]) {
    const previous: unknown = Reflect.apply(target, receiver, args);
    const [array, , expected] = args;
    if (
      !paused &&
      array instanceof BigInt64Array &&
      array.buffer === data.input &&
      expected === 0n &&
      previous === 0n
    ) {
      paused = true;
      Atomics.store(cells, 0, 1);
      Atomics.notify(cells, 0);
      Atomics.wait(cells, 1, 0);
    }
    return previous;
  },
});
const { attachTerminal, createTerminalInputPolicy } =
  await import("waffle/browser/runtime-terminals");
const base = createTerminalInputPolicy({ input: data.input });
const attachment = attachTerminal({
  context: data.context,
  process: data.process,
  checkActive() {},
  policy: { ...base, inputReadiness: () => ({ readable: true, nbytes: 1 }) },
});
try {
  Atomics.store(cells, 2, attachment.resolve(0).tryRead!([new Uint8Array(1)]));
} finally {
  attachment.dispose();
  Atomics.store(cells, 3, 1);
  Atomics.notify(cells, 3);
}
