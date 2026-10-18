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
