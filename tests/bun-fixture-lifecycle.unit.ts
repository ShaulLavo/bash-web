import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Runtime } from "waffle";
import { createFilesystemIdentity, type FilesystemConnection } from "waffle/fs/protocol";
import { createBunRuntimeLease, type InstallBunAdapters } from "./helpers/bun-fixture";

function browserOwner(context: TestContext) {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.test/" },
  });
  const connections: FilesystemConnection[] = [];
  globalThis.Worker = class extends EventTarget {
    postMessage(message: { connect?: FilesystemConnection; dispose?: boolean }) {
      if (message.connect) connections.push(message.connect);
      if (message.dispose) {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", { data: { type: "filesystem-disposed" } }),
          ),
        );
      }
    }
    terminate() {}
  } as unknown as typeof Worker;
  let runtime: Runtime | undefined;
  context.after(async () => {
    try {
      await runtime?.dispose();
    } finally {
      for (const connection of connections) connection.port.close();
      globalThis.Worker = previousWorker;
      if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
      else Reflect.deleteProperty(globalThis, "location");
    }
  });
  return (install: InstallBunAdapters) =>
    createBunRuntimeLease((borrowed, options) => {
      runtime = borrowed;
      return install(borrowed, options);
    }, "https://example.test/bun-worker.js");
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("async Bun installation finishes before readiness and disposal", async (context) => {
  const create = browserOwner(context);
  const installation = Promise.withResolvers<void>();
  const events: string[] = [];
  const dispose = () => {
    assert.equal(lease.runtime.disposed, true);
    events.push("adapter-disposed");
  };
  const lease = create(async () => {
    await installation.promise;
    events.push("installed");
    return { dispose };
  });
  const ready = lease.ready.then(() => events.push("ready"));
  const cleanup = Promise.allSettled([lease.dispose()]);
  try {
    await turn();
    assert.deepEqual(events, [], "ready and disposal must wait for installation");
    assert.equal(lease.runtime.disposed, false);
  } finally {
    installation.resolve();
    await ready;
    await cleanup;
  }
  assert.deepEqual(events, ["installed", "ready", "adapter-disposed"]);
  assert.deepEqual(await cleanup, [{ status: "fulfilled", value: undefined }]);
});

test("Bun adapter cleanup sees runtime revocation before it starts", async (context) => {
  const create = browserOwner(context);
  let disposed = false;
  const lease = create(async (runtime) => ({
    async dispose() {
      assert.equal(runtime.disposed, true, "storage cancellation must precede adapter cleanup");
      await turn();
      disposed = true;
    },
  }));
  await lease.ready;
  const first = lease.dispose();
  assert.equal(lease.dispose(), first, "the owner returns one teardown promise");
  await first;
  assert.equal(disposed, true);
});

test("a failing adapter still awaits the runtime's physical teardown", async (context) => {
  const create = browserOwner(context);
  let releaseStop!: () => void;
  const physicalStop = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let stopping = false;
  const failure = new Error("Adapter cleanup failed");
  const lease = create(async (runtime) => {
    runtime.retainConsumer({
      filesystem: createFilesystemIdentity(undefined, 1024 * 1024),
      revoke() {},
      async stop() {
        stopping = true;
        await physicalStop;
      },
    });
    return {
      dispose() {
        throw failure;
      },
    };
  });
  await lease.ready;
  let settled = false;
  const disposing = lease.dispose();
  const rejected = assert.rejects(disposing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    settled = true;
    return true;
  });
  try {
    await turn();
    assert.equal(stopping, true);
    assert.equal(settled, false, "adapter failure must not let a live runtime escape teardown");
  } finally {
    releaseStop();
    await rejected;
  }
  assert.equal(settled, true);
});

test("failed adapter installation still disposes the runtime and preserves its error", async (context) => {
  const create = browserOwner(context);
  const failure = new Error("Adapter installation failed");
  let borrowed: Runtime | undefined;
  const lease = create(async (runtime) => {
    borrowed = runtime;
    throw failure;
  });
  await assert.rejects(lease.ready, failure);
  await assert.rejects(lease.dispose(), failure);
  assert.equal(borrowed?.disposed, true);
});
