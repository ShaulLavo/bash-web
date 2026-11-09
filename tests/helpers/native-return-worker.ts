import { parentPort, workerData } from "node:worker_threads";
import { captureProcessObserver } from "waffle/proc/observation";
import type { ProcessObservationTransfer } from "waffle/proc/observation";
import type { ShellWorkerRequest } from "../../src/runtime/worker";

if (!parentPort) throw new Error("Native-return control has no parent port");
const port = parentPort;
const entry: unknown = workerData.entry;
if (typeof entry !== "string") throw new Error("Native-return control has no shell worker asset");
const events = new EventTarget();
Object.defineProperties(globalThis, {
  postMessage: { value: (message: unknown) => port.postMessage(message), configurable: true },
  addEventListener: { value: events.addEventListener.bind(events), configurable: true },
  removeEventListener: { value: events.removeEventListener.bind(events), configurable: true },
});
type Command =
  | { id: number; operation: "observe"; observation: ProcessObservationTransfer }
  | { id: number; operation: "start"; request: ShellWorkerRequest };
port.on("message", async (command: Command) => {
  try {
    if (command.operation === "observe") {
      const observed = captureProcessObserver(command.observation).read();
      port.postMessage({ id: command.id, observed });
      return;
    }
    await import(entry);
    const handler: unknown = Reflect.get(globalThis, "onmessage");
    if (typeof handler !== "function") throw new Error("Shell worker did not install its entry");
    await handler(new MessageEvent("message", { data: command.request }));
    port.postMessage({ id: command.id, completed: true });
  } catch (error) {
    port.postMessage({ id: command.id, error: String(error) });
  }
});
