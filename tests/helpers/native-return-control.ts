import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { Worker, MessagePort } from "node:worker_threads";
import type { ProcessObservationTransfer } from "waffle/proc/observation";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";
import type { ShellWorkerRequest } from "../../src/runtime/worker";

type Reply = { id: number; observed?: unknown; completed?: boolean; error?: string };
export function nativeReturnControl(
  context: TestContext,
  onMessage?: (message: RuntimeWorkerMessage) => void,
) {
  const worker = new Worker(resolve(".build/native-return-worker.mjs"), {
    execArgv: [],
    workerData: { entry: pathToFileURL(resolve(".build/browser/shell-worker.js")).href },
  });
  context.after(async () => {
    await worker.terminate();
  });
  let sequence = 0;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
  const messages: RuntimeWorkerMessage[] = [];
  worker.on("message", (message: Reply | RuntimeWorkerMessage) => {
    if (!("id" in message)) {
      messages.push(message);
      onMessage?.(message);
      return;
    }
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  async function request(command: object, transfer: readonly unknown[] = []): Promise<Reply> {
    const id = ++sequence;
    const reply = Promise.withResolvers<Reply>();
    pending.set(id, reply);
    worker.postMessage(
      { ...command, id },
      transfer.filter((value): value is MessagePort => value instanceof MessagePort),
    );
    return reply.promise;
  }
  return {
    worker,
    messages,
    async observe(observation: ProcessObservationTransfer) {
      const reply = await request({ operation: "observe", observation });
      assert.equal(reply.error, undefined);
      return reply.observed;
    },
    async start(requestData: ShellWorkerRequest) {
      const reply = await request({ operation: "start", request: requestData }, [
        requestData.filesystem.port,
      ]);
      assert.equal(reply.error, undefined);
      assert.equal(reply.completed, true);
    },
  };
}

type NativeStop = (native: () => Promise<void>) => void | Promise<void>;
export function nativeShellWorker(context: TestContext, stop?: NativeStop) {
  class ShellWorker extends EventTarget implements globalThis.Worker {
    onerror: globalThis.Worker["onerror"] = null;
    onmessage: globalThis.Worker["onmessage"] = null;
    onmessageerror: globalThis.Worker["onmessageerror"] = null;
    readonly control = nativeReturnControl(context, (message) => {
      this.onmessage?.(new MessageEvent("message", { data: message }));
    });
    postMessage(request: ShellWorkerRequest) {
      void this.control.start(request);
    }
    terminate() {
      const native = () => this.control.worker.terminate().then(() => {});
      return stop ? stop(native) : native();
    }
  }
  return new ShellWorker();
}
