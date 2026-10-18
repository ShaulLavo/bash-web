// One fresh Waffle Runtime per case: real registered guests, separate raw output streams.
// The parent pool terminates this whole thread, with its runtime, at the case timeout.
import { parentPort, workerData } from "node:worker_threads";
import { createWaffleRunner } from "./waffle-compat.ts";

if (workerData.engine !== "own-shell")
  throw new Error(`Unknown compatibility engine: ${workerData.engine}`);
const run = await createWaffleRunner(workerData);
parentPort.on("message", async ({ id, code }) => {
  try {
    parentPort.postMessage({ id, ...(await run(code)) });
  } catch (error) {
    parentPort.postMessage({
      id,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      crash: String(error?.message ?? error),
    });
  }
});
parentPort.postMessage({ ready: true });
