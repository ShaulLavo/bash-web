import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Runtime, RuntimeConsumer } from "waffle";
import { ProcessIdentityAllocator } from "waffle/proc/identity";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  reapFilesystem,
} from "waffle/fs/protocol";
import { BrowserSession } from "./session";
import { acquireBrowserRuntime } from "./runtime";

function pendingRuntime(context: TestContext) {
  const isolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  let finishInitialization!: () => void;
  const initialization = new Promise<void>((resolve) => {
    finishInitialization = resolve;
  });
  const consumers = new Set<RuntimeConsumer>();
  const connections: ReturnType<typeof connectFilesystemIdentity>[] = [];
  let processAdmissions = 0;
  let ownerDisposals = 0;
  const runtime = {
    disposed: false,
    identities: new ProcessIdentityAllocator(),
    registerAdapter() {},
    registerProgram() {},
    retainConsumer(consumer: RuntimeConsumer) {
      consumers.add(consumer);
      return () => {
        consumers.delete(consumer);
      };
    },
    filesystem: {
      state: { status: "ready" },
      mkdirp: () => initialization,
      async lookup() {
        return true;
      },
      async drain() {},
      fork() {
        const connection = connectFilesystemIdentity(createFilesystemIdentity());
        connections.push(connection);
        return connection.client;
      },
      reap: reapFilesystem,
    },
    async processes() {
      processAdmissions++;
      throw new Error("Cancelled session admitted a process");
    },
    async dispose() {
      ownerDisposals++;
    },
  } as unknown as Runtime;
  context.after(async () => {
    finishInitialization();
    // Let the page-owned, shared initialization finish before retiring its test ports.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const connection of connections) {
      connection.client.port.close();
      connection.server.port.close();
    }
    if (isolation) Object.defineProperty(globalThis, "crossOriginIsolated", isolation);
    else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  });
  return {
    runtime,
    consumers,
    finishInitialization,
    processAdmissions: () => processAdmissions,
    ownerDisposals: () => ownerDisposals,
  };
}

function options(runtime: Runtime) {
  return { runtime, cols: 80, rows: 24, onOutput() {}, onState() {} };
}

test("startup timeout releases pending shell consumer before rejecting and never admits it later", async (context) => {
  const fixture = pendingRuntime(context);
  const starting = BrowserSession.create({ ...options(fixture.runtime), startupTimeoutMs: 5 });
  assert.equal(fixture.consumers.size, 1);
  await assert.rejects(starting, /Shell startup exceeded/);
  assert.equal(fixture.consumers.size, 0, "startup failure must await admission cleanup");
  assert.equal(fixture.ownerDisposals(), 0, "the supplied runtime belongs to the application");
  fixture.finishInitialization();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.processAdmissions(), 0);
});

test("host cancellation releases a session whose create promise has not returned a facade", async (context) => {
  const fixture = pendingRuntime(context);
  const controller = new AbortController();
  const starting = BrowserSession.create({
    ...options(fixture.runtime),
    signal: controller.signal,
  });
  assert.equal(fixture.consumers.size, 1);
  controller.abort(new Error("Host unmounted"));
  await assert.rejects(starting, /cancelled/);
  assert.equal(fixture.consumers.size, 0);
  assert.equal(fixture.ownerDisposals(), 0);
  fixture.finishInitialization();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.processAdmissions(), 0);
});

test("an already cancelled host never retains a shell consumer", async (context) => {
  const fixture = pendingRuntime(context);
  const controller = new AbortController();
  controller.abort(new Error("Already unmounted"));
  await assert.rejects(
    BrowserSession.create({ ...options(fixture.runtime), signal: controller.signal }),
    /Already unmounted/,
  );
  assert.equal(fixture.consumers.size, 0);
  assert.equal(fixture.ownerDisposals(), 0);
});

test("borrowed runtime ignores storage selection and lease disposal leaves its owner live", async (context) => {
  const fixture = pendingRuntime(context);
  const lease = acquireBrowserRuntime(
    { runtime: fixture.runtime },
    { workerURL: "unused", search: "?mode=safe" },
  );
  assert.equal(lease.runtime, fixture.runtime);
  await lease.ready;
  const controller = new AbortController();
  const starting = BrowserSession.create({ ...options(lease.runtime), signal: controller.signal });
  controller.abort(new Error("Borrower stopped"));
  await assert.rejects(starting, /cancelled/);
  await lease.dispose();
  assert.equal(fixture.ownerDisposals(), 0);
  assert.equal(fixture.consumers.size, 0);
});

test("factory lease keeps its readiness and cleanup owner without reading storage selection", async (context) => {
  const fixture = pendingRuntime(context);
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  context.after(releaseReady);
  let releases = 0;
  const ownedLease = { runtime: fixture.runtime, ready, dispose: async () => { releases++; } };
  const observe = () => {};
  const lease = acquireBrowserRuntime(
    {
      acquireRuntime(onStartupStage) {
        assert.equal(onStartupStage, observe);
        return ownedLease;
      },
    },
    {
      workerURL: "unused",
      get search(): string {
        throw new Error("Borrower read a storage selector");
      },
      onStartupStage: observe,
    },
  );
  assert.equal(lease, ownedLease);
  assert.equal(lease.ready, ready);
  await lease.dispose();
  assert.equal(releases, 1);
  assert.equal(fixture.ownerDisposals(), 0);
});
