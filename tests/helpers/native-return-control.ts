import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { Worker, type MessagePort } from "node:worker_threads";
import type { ProcessObservationTransfer } from "waffle/proc/observation";
import type { ShellWorkerRequest } from "../../src/runtime/worker";

type Reply = { id: number; observed?: unknown; completed?: boolean; error?: string };
export function nativeReturnControl(context: TestContext) {
  const worker = new Worker(resolve(".build/native-return-worker.mjs"), { execArgv: [] });
  context.after(async () => {
    await worker.terminate();
  });
  let sequence = 0;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
  const messages: unknown[] = [];
  worker.on("message", (message: Reply) => {
    if (!message.id) {
      messages.push(message);
      return;
    }
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  async function request(command: object, transfer: MessagePort[] = []): Promise<Reply> {
    const id = ++sequence;
    const reply = Promise.withResolvers<Reply>();
    pending.set(id, reply);
    worker.postMessage({ ...command, id }, transfer);
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
