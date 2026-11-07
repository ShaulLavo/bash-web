import type { TestContext } from "node:test";
import { createRuntime, type RuntimeOptions } from "waffle";
import { MemoryBackend } from "waffle/fs/backend";
import type { FilesystemConnection } from "waffle/fs/protocol";
import { FilesystemService } from "waffle/fs/service";
import {
  BrowserProcessBroker,
  type BrowserProcessBrokerOptions,
} from "waffle/browser/process-broker";

// Only the browser Worker boundary is local. The runtime, reservation ledger,
// filesystem protocol and process broker keep their public ownership paths.
class FilesystemWorker extends EventTarget implements Worker {
  onerror: Worker["onerror"] = null;
  onmessage: Worker["onmessage"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  private readonly service = new FilesystemService(new MemoryBackend());
  private connection?: FilesystemConnection;

  postMessage(message: { connect?: FilesystemConnection; dispose?: boolean }) {
    if (message.connect) this.connect(message.connect);
    if (message.dispose) {
      this.terminate();
      queueMicrotask(() => this.reply({ type: "filesystem-disposed" }));
    }
  }

  private connect(connection: FilesystemConnection) {
    this.connection = connection;
    this.service.connect(connection);
    queueMicrotask(() => this.reply({ type: "filesystem-state", status: "ready" }));
  }

  private reply(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  terminate() {
    this.service.dispose();
    this.connection?.port.close();
  }
}

export function createFixtureRuntime(context: TestContext, options: RuntimeOptions = {}) {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FilesystemWorker;
  try {
    const runtime = createRuntime({
      ...options,
      filesystem: { workerURL: "https://fixture.test/fs-worker.js", ...options.filesystem },
    });
    context.after(() => runtime.dispose());
    return runtime;
  } finally {
    globalThis.Worker = previousWorker;
  }
}

export async function createFixtureBroker(
  context: TestContext,
  options: Omit<BrowserProcessBrokerOptions, "reservations">,
) {
  let broker: BrowserProcessBroker | undefined;
  let createBroker:
    | ((options: Omit<BrowserProcessBrokerOptions, "reservations">) => BrowserProcessBroker)
    | undefined;
  const runtime = createFixtureRuntime(context, {
    processHost(owned) {
      createBroker = (overrides) => new BrowserProcessBroker({ ...owned, ...overrides });
      broker = new BrowserProcessBroker({ ...owned, ...options });
      return broker;
    },
  });
  const service = await runtime.processes();
  if (!broker || !createBroker) throw new Error("Runtime did not activate its process host");
  return { runtime, broker, service, createBroker };
}
