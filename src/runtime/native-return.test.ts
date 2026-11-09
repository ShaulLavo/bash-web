import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { captureNativeReturn, captureProcessObserver } from "waffle/proc/observation";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { createFilesystemIdentity, connectFilesystemIdentity } from "waffle/fs/protocol";
import { pages } from "waffle";
import { createFixtureRuntime } from "../../tests/helpers/runtime-owner";
import { name, section } from "../../tests/helpers/wasm-binary";
import { SharedBridge } from "../bridge";
import { createTerminalController } from "./terminal-controller";
import { captureShellWorkerStop } from "./native-stop";
import type { ShellWorkerRequest } from "./worker";
import { startShell } from "./shell-host";
import { nativeReturnControl, nativeShellWorker } from "../../tests/helpers/native-return-control";

function request(context: TestContext) {
  const transport = createWorkerProcessTransport({ capacity: 4 });
  const terminal = new SharedBridge();
  const controller = createTerminalController({ disposed: false }, transport, terminal, (error) => {
    throw error;
  });
  context.after(() => controller.quiesce());
  const connection = connectFilesystemIdentity(createFilesystemIdentity(undefined, 1024 * 1024));
  context.after(() => {
    connection.client.port.close();
    connection.server.port.close();
  });
  transport.data = { ...controller.metadata };
  const request: ShellWorkerRequest = {
    runtimeProcess: transport,
    module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    args: [],
    env: {},
    filesystem: connection.client,
    controlGrant: { kind: "unbounded" },
    terminal: terminal.buffer,
  };
  return { request, transport };
}

for (const returned of [false, true]) {
  test(
    `native-return late shell bootstrap preserves ${returned ? "terminated" : "selected"} observation`,
    { timeout: 10000 },
    async (context) => {
      const control = nativeReturnControl(context);
      const f = request(context);
      const observer = captureProcessObserver(f.transport);
      assert.deepEqual(await control.observe(f.transport), { kind: "pending" });
      const result = claimOutcome(workerProcessState(f.transport).signals.outcome, {
        kind: "exited",
        code: 23,
      });
      assert.deepEqual(await control.observe(f.transport), { kind: "selected", result });
      if (returned) captureNativeReturn(f.transport)();
      assert.deepEqual(
        observer.read(),
        returned ? { kind: "terminated" } : { kind: "selected", result },
      );
      await control.start(f.request);
      const exits = control.messages.filter((message) => message.type === "exit");
      assert.equal(exits.length, returned ? 0 : 1);
      assert.deepEqual(await control.observe(f.transport), observer.read());
    },
  );
}

for (const mode of ["held", "void", "fulfilled", "throwing", "rejected"] as const) {
  test(
    `native-return root stop ${mode} keeps lifecycle separate from retirement`,
    { timeout: 10000 },
    async (context) => {
      const control = nativeReturnControl(context);
      const target = nativeReturnControl(context);
      const transport = createWorkerProcessTransport({ capacity: 4 });
      assert.deepEqual(await target.observe(transport), { kind: "pending" });
      const observer = captureProcessObserver(transport);
      const stop = captureShellWorkerStop(transport);
      const result = claimOutcome(workerProcessState(transport).signals.outcome, {
        kind: "exited",
        code: 19,
      });
      assert.deepEqual(await control.observe(transport), { kind: "selected", result });
      const held = Promise.withResolvers<void>();
      context.after(() => held.resolve());
      let calls = 0;
      const failure = new Error("Native stop failed");
      const worker = {
        terminate() {
          calls++;
          assert.deepEqual(observer.read(), { kind: "selected", result });
          if (mode === "throwing") throw failure;
          if (mode === "rejected") return Promise.reject(failure);
          const terminate = () => target.worker.terminate().then(() => {});
          if (mode === "held") return held.promise.then(terminate);
          if (mode === "fulfilled") return terminate();
          void terminate();
        },
      };
      if (mode === "throwing")
        assert.throws(
          () => stop(worker),
          (error) => error === failure,
        );
      else if (mode === "rejected")
        await assert.rejects(Promise.resolve(stop(worker)), (error) => error === failure);
      else {
        const stopping = stop(worker);
        if (mode === "void") assert.deepEqual(observer.read(), { kind: "terminated" });
        if (mode === "held") {
          assert.deepEqual(await control.observe(transport), { kind: "selected", result });
          held.resolve();
        }
        await stopping;
      }
      assert.equal(calls, 1);
      const failed = mode === "throwing" || mode === "rejected";
      if (failed) assert.deepEqual(await target.observe(transport), { kind: "selected", result });
      assert.deepEqual(
        await control.observe(transport),
        failed ? { kind: "selected", result } : { kind: "terminated" },
      );
      assert.deepEqual(captureProcessObserver(transport).read(), observer.read());
      assert.equal(readOutcome(workerProcessState(transport).signals.outcome)?.code, 19);
    },
  );
}

test(
  "native-return pre-adoption cancellation expires the unlaunched directory",
  { timeout: 10000 },
  async (context) => {
    const control = nativeReturnControl(context);
    const transport = createWorkerProcessTransport({ capacity: 4 });
    assert.deepEqual(await control.observe(transport), { kind: "pending" });
    const stop = captureShellWorkerStop(transport);
    claimOutcome(workerProcessState(transport).signals.outcome, { kind: "signaled", code: 9 });
    stop();
    assert.deepEqual(await control.observe(transport), { kind: "terminated" });
  },
);

function exitGuest(code: number) {
  const body = [0, 0x41, code, 0x10, 0, 0x0b];
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      section(2, [1].concat(name("wasi_snapshot_preview1"), name("proc_exit"), [0, 0])),
      section(3, [1, 1]),
      section(5, [1, 1, 1, 1]),
      section(7, [2].concat(name("_start"), [0, 1], name("memory"), [2, 0])),
      section(10, [1, body.length].concat(body)),
    ),
  );
}

test(
  "native-return positive shell bootstrap executes in the measured CPU Worker",
  { timeout: 10000 },
  async (context) => {
    const runtime = createFixtureRuntime(context);
    const service = await runtime.processes();
    const filesystem = runtime.filesystem.fork();
    context.after(() => filesystem.port.close());
    const { port: _port, ...identity } = filesystem;
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
      capacity: 4,
    });
    const terminal = new SharedBridge();
    const controller = createTerminalController(runtime, transport, terminal, (error) => {
      throw error;
    });
    context.after(() => controller.quiesce());
    transport.data = { filesystem: identity, ...controller.metadata };
    const control = nativeReturnControl(context, (message) => {
      if (message.type === "shared-control-allocation")
        service.rootControlAllocated(transport.pid, message.buffer);
    });
    const stop = captureShellWorkerStop(transport);
    await service.adoptRuntimeRoot(transport, {
      memory: [{ kind: "private", origin: "defined", maximumPages: pages(1) }],
      filesystem: identity,
      quiesce: () => controller.quiesce(),
      stop: () => stop({ terminate: () => control.worker.terminate().then(() => {}) }),
    });
    assert.deepEqual(await control.observe(service.rootObservation(transport.pid)), {
      kind: "pending",
    });
    await control.start({
      runtimeProcess: transport,
      module: new WebAssembly.Module(exitGuest(17)),
      args: [],
      env: {},
      filesystem,
      controlGrant: service.rootControlGrant(transport.pid),
      terminal: terminal.buffer,
    });
    assert.deepEqual(
      control.messages.filter((message) => message.type === "exit").map((message) => message.code),
      [17],
    );
    assert.deepEqual(await control.observe(transport), {
      kind: "selected",
      result: { kind: "exited", code: 17, status: 17 },
    });
    await service.rootExit(transport.pid, 17);
    await stop({ terminate: () => control.worker.terminate().then(() => {}) });
    service.rootStopped(transport.pid);
    assert.deepEqual(captureProcessObserver(transport).read(), { kind: "terminated" });
    assert.equal(runtime.disposed, false);
  },
);

for (const mode of ["void", "fulfilled", "held", "reentrant", "late", "pre-adoption"] as const) {
  test(
    `native-return shell host ${mode} joins its acquired CPU Worker`,
    { timeout: 10000 },
    async (context) => {
      const held = Promise.withResolvers<void>();
      context.after(() => held.resolve());
      const owner = createFixtureRuntime(context);
      const service = { ...(await owner.processes()) };
      const runtime = {
        ...owner,
        get disposed() {
          return owner.disposed;
        },
        processes: async () => service,
      };
      const previousFetch = globalThis.fetch;
      context.after(() => {
        globalThis.fetch = previousFetch;
      });
      globalThis.fetch = async () => new Response(exitGuest(17));
      const entered = Promise.withResolvers<void>();
      const observerWorker = nativeReturnControl(context);
      const cancellation = new AbortController();
      const cancelled = new Error("Cancelled before adoption");
      let nativeStops = 0;
      let reentrant: Promise<void> | undefined;
      let pageDisposal: Promise<void> | undefined;
      let ownerStop = () => Promise.resolve();
      let transport: Parameters<typeof captureProcessObserver>[0] | undefined;
      const worker = nativeShellWorker(context, (native) => {
        nativeStops++;
        entered.resolve();
        assert.ok(transport);
        assert.equal(captureProcessObserver(transport).read().kind, "selected");
        if (mode === "reentrant") reentrant = ownerStop();
        if (mode === "held") return held.promise.then(native);
        if (mode === "void") {
          void native();
          return;
        }
        return native();
      });
      const adopt = service.adoptRuntimeRoot.bind(service);
      service.adoptRuntimeRoot = async (root, options) => {
        transport = root;
        if (mode === "pre-adoption") {
          assert.deepEqual(await observerWorker.observe(root), { kind: "pending" });
          cancellation.abort(cancelled);
          throw cancelled;
        }
        ownerStop = async () => {
          await options.stop?.();
        };
        await adopt(root, options);
        assert.deepEqual(await observerWorker.observe(service.rootObservation(root.pid)), {
          kind: "pending",
        });
      };
      service.takeWorker = () => {
        if (mode === "late") pageDisposal = runtime.dispose();
        return worker;
      };
      const terminal = new SharedBridge();
      const starting = startShell(
        {
          runtime,
          script: "ignored",
          wasmUrl: "https://native.test/guest.wasm",
          workerUrl: "https://native.test/worker.js",
          signal: cancellation.signal,
        },
        terminal,
      );
      if (mode === "pre-adoption") {
        await assert.rejects(starting, (error) => error === cancelled);
        assert.ok(transport);
        assert.deepEqual(await observerWorker.observe(transport), { kind: "terminated" });
        assert.equal(runtime.disposed, false);
        assert.equal(nativeStops, 0);
        return;
      }
      if (mode === "late") {
        await assert.rejects(starting, /Runtime is disposed|Runtime was disposed/);
        await pageDisposal;
        assert.equal(nativeStops, 1);
        assert.ok(transport);
        assert.deepEqual(await observerWorker.observe(transport), { kind: "terminated" });
        return;
      }
      const process = await starting;
      assert.equal((await process.done).code, 17);
      const disposing = process.dispose();
      await entered.promise;
      assert.ok(transport);
      if (mode === "held") {
        assert.equal(captureProcessObserver(transport).read().kind, "selected");
        held.resolve();
      }
      await disposing;
      await reentrant;
      assert.equal(nativeStops, 1);
      assert.deepEqual(await observerWorker.observe(transport), { kind: "terminated" });
      assert.equal(runtime.disposed, false);
    },
  );
}
