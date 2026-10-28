// Original facade lifetime regressions. Waffle's real identity/connection protocol is used;
// only browser workers and the page's already-owned service capabilities are stubbed.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ProcessService, Runtime, RuntimeConsumer } from "waffle";
import {
  BrowserProcessBroker,
  type ProcessController,
  type RuntimeRootOptions,
  type WorkerLaunchOptions,
} from "waffle/browser/process-broker";
import { createProcessIdentity } from "waffle/browser/process-context";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessTable } from "waffle/proc/table";
import type { ChildExitEvent, ProcessContext } from "waffle/proc/types";
import type { ShellWorkerRequest } from "./worker";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  waitForFilesystemQuiescence,
  revokeFilesystem,
  reapFilesystem,
  type FilesystemIdentity,
} from "waffle/fs/protocol";
import { ProcessIdentityAllocator } from "waffle/proc/identity";
import { DescriptorTable } from "waffle/core/descriptors";
import { requestSignal } from "waffle/proc/signals";
import { claimOutcome } from "waffle/proc/outcome";
import { SharedBridge, control, OUTPUT_CAPACITY } from "../bridge";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { createShell } from "../shell";
import { runtimeSnapshot } from "./diagnostics";
import { registerShell } from "./shell-host";
import { createStartupDiagnostics } from "./startup-diagnostics";
import { launchTerminalWorker } from "./worker-launcher";

function quiesceFilesystem(identity: FilesystemIdentity): Promise<void> {
  revokeFilesystem(identity);
  return waitForFilesystemQuiescence(identity);
}
function fixture(
  context: TestContext,
  failConstructor = false,
  startFailure?: 2 | 13,
  holdStart = false,
  programFailures = 0,
) {
  const previousWorker = globalThis.Worker;
  const previousFetch = globalThis.fetch;
  const ports: ReturnType<typeof connectFilesystemIdentity>[] = [];
  const consumers = new Set<RuntimeConsumer>();
  const adapters = new Map<string, Parameters<Runtime["registerAdapter"]>[1]>();
  const roots = new Map<
    number,
    { transport: WorkerProcessTransport; options: RuntimeRootOptions }
  >();
  const reaped: FilesystemIdentity[] = [];
  const requests: unknown[] = [];
  let requestPosted!: () => void;
  const posted = new Promise<void>((resolve) => {
    requestPosted = resolve;
  });
  const rootStatuses: number[] = [];
  const exitListeners = new Set<(event: ChildExitEvent) => void>();
  const events: string[] = [];
  let disposed = false;
  let borrowedAfterDispose = 0;
  let ownerDisposals = 0;
  let terminated = 0;
  let firstReleased!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    firstReleased = resolve;
  });
  const live = () => {
    if (disposed) {
      borrowedAfterDispose++;
      throw new Error("Borrowed capability used after page disposal");
    }
  };
  const service = {
    async ready() {
      live();
      return {
        table: new Map(),
        onChildExit(listener: (event: ChildExitEvent) => void) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
      };
    },
    async adoptRuntimeRoot(transport: WorkerProcessTransport, options: RuntimeRootOptions) {
      live();
      roots.set(workerProcessState(transport).pid, { transport, options });
    },
    takeWorker(url: string) {
      live();
      return new Worker(url, { type: "module" });
    },
    async rootExit(pid: number, status: number) {
      live();
      rootStatuses.push(status);
      const root = roots.get(pid)!;
      await Promise.all([root.options.quiesce?.(), quiesceFilesystem(root.options.filesystem!)]);
      events.push("fenced");
      root.options.retired?.();
      roots.delete(pid);
    },
    async killJob(job: number, signal: 9) {
      live();
      for (const root of roots.values()) {
        const state = workerProcessState(root.transport);
        if (state.job === job) requestSignal(state.signals, signal);
      }
    },
  } as unknown as ProcessService;
  const runtime = {
    identities: new ProcessIdentityAllocator(),
    get disposed() {
      return disposed;
    },
    filesystem: {
      async mkdirp() {
        live();
      },
      async lookup() {
        live();
        return undefined;
      },
      async writeFile() {
        live();
      },
      async drain() {
        live();
      },
      fork() {
        live();
        const connection = connectFilesystemIdentity(
          createFilesystemIdentity(undefined, 1024 * 1024),
        );
        ports.push(connection);
        const close = connection.client.port.close.bind(connection.client.port);
        connection.client.port.close = () => {
          events.push("port-closed");
          close();
        };
        return connection.client;
      },
      reap(identity: FilesystemIdentity) {
        live();
        reaped.push(identity);
        reapFilesystem(identity);
      },
      async quiesce(identity: FilesystemIdentity) {
        live();
        await quiesceFilesystem(identity);
      },
    },
    registerAdapter(name: string, adapter: Parameters<Runtime["registerAdapter"]>[1]) {
      live();
      adapters.set(name, adapter);
      return () => {
        if (adapters.get(name) === adapter) adapters.delete(name);
      };
    },
    registerProgram() {
      live();
      if (programFailures) {
        programFailures--;
        throw new Error("Program registration refused");
      }
      return () => {};
    },
    retainConsumer(consumer: RuntimeConsumer) {
      live();
      consumers.add(consumer);
      return () => {
        if (!disposed && consumers.delete(consumer)) firstReleased();
      };
    },
    async processes() {
      live();
      return service;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      ownerDisposals++;
      for (const consumer of consumers) consumer.revoke();
      await Promise.all(
        Array.from(consumers, (consumer) => quiesceFilesystem(consumer.filesystem)),
      );
      events.push("owner-fenced");
      await Promise.all(Array.from(consumers, (consumer) => consumer.stop()));
      consumers.clear();
    },
  } as unknown as Runtime;
  globalThis.fetch = async () => new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  globalThis.Worker = class {
    onmessage?: (message: { data: unknown }) => void;
    postMessage(request: unknown) {
      requests.push(request);
      requestPosted();
      if (holdStart) return;
      queueMicrotask(() => {
        if (startFailure) {
          const transport = (request as ShellWorkerRequest).runtimeProcess!;
          claimOutcome(workerProcessState(transport).signals.outcome, {
            kind: "start-failed",
            code: startFailure,
          });
          this.onmessage?.({
            data: {
              type: "error",
              code: startFailure === 2 ? 127 : 126,
              message: "Probe startup failure",
            },
          });
        } else this.onmessage?.({ data: { type: "phase", name: "instantiate", duration: 0 } });
      });
    }
    constructor() {
      if (failConstructor) throw new Error("Worker construction refused");
    }
    terminate() {
      events.push("terminated");
      terminated++;
    }
  } as unknown as typeof Worker;
  context.after(async () => {
    await runtime.dispose();
    for (const connection of ports) {
      connection.client.port.close();
      connection.server.port.close();
    }
    globalThis.Worker = previousWorker;
    globalThis.fetch = previousFetch;
  });
  const options = {
    runtime,
    wasmUrl: "https://shell.example/shell-engine.wasm",
    workerUrl: "https://shell.example/worker.js",
  };
  return {
    runtime,
    firstRelease,
    options,
    service,
    consumers,
    adapters,
    reaped,
    requests,
    posted,
    rootStatuses,
    roots,
    exitListeners,
    events,
    get borrowedAfterDispose() {
      return borrowedAfterDispose;
    },
    get ownerDisposals() {
      return ownerDisposals;
    },
    get terminated() {
      return terminated;
    },
  };
}

for (const failure of [2, 13] as const)
  test(`shared startup failure ${failure} preserves its diagnostic and publishes shell wait status`, async (context) => {
    const host = fixture(context, false, failure);
    const terminal = new SharedBridge();
    const status = failure === 2 ? 127 : 126;
    await assert.rejects(createShell({ ...host.options, terminal }), /Probe startup failure/);
    assert.equal(Atomics.load(terminal.state, control.status), status);
    assert.equal(Atomics.load(terminal.state, control.phase), 4);
    assert.deepEqual(host.rootStatuses, [status]);
    assert.equal(host.consumers.size, 0);
    assert.equal(host.terminated, 1);
    assert.equal(host.runtime.disposed, false);
  });

test("later shell admissions retry a failed shared fetch without invalidating a successful module", async (context) => {
  const host = fixture(context);
  let fetches = 0;
  globalThis.fetch = async () =>
    ++fetches === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  await Promise.all([
    assert.rejects(createShell(host.options), /Shell executable fetch failed \(503\)/),
    assert.rejects(createShell(host.options), /Shell executable fetch failed \(503\)/),
  ]);
  assert.equal(fetches, 1);
  assert.equal(host.consumers.size, 0);
  const first = await createShell(host.options);
  const second = await createShell(host.options);
  assert.equal(fetches, 2);
  await first.dispose();
  await second.dispose();
  assert.equal(host.consumers.size, 0);
  assert.equal(host.runtime.disposed, false);
});

test("page disposal cancels a shell stalled before executable fetch completes", async (context) => {
  const host = fixture(context);
  let complete!: (response: Response) => void;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const pending = createShell(host.options);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.consumers.size, 1);
  const disposed = host.runtime.dispose();
  await assert.rejects(pending, /Runtime is disposed/);
  await disposed;
  assert.equal(host.consumers.size, 0);
  // The fetch belongs to the embedding and may settle after the runtime fence.
  complete(new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)));
});

test("failed program registration releases the adapter lease for a later retry", (context) => {
  const host = fixture(context, false, undefined, false, 1);
  assert.throws(() => registerShell(host.runtime, host.options), /Program registration refused/);
  assert.equal(host.adapters.size, 0);
  assert.doesNotThrow(() => registerShell(host.runtime, host.options));
  assert.equal(host.adapters.size, 1);
});

test("a later shell retries failed filesystem initialization", async (context) => {
  const host = fixture(context);
  const mkdirp = host.runtime.filesystem.mkdirp;
  let attempts = 0;
  host.runtime.filesystem.mkdirp = async (...args) => {
    if (++attempts === 1) throw new Error("Recoverable filesystem initialization failure");
    await mkdirp(...args);
  };
  await assert.rejects(createShell(host.options), /Recoverable filesystem initialization failure/);
  assert.equal(host.consumers.size, 0);
  assert.equal(host.requests.length, 0);
  const shell = await createShell(host.options);
  assert.equal(attempts, 5);
  assert.equal(host.requests.length, 1);
  await shell.dispose();
  assert.equal(host.consumers.size, 0);
});

test("supervisor completion settles a root without a repeating page timer", async (context) => {
  const host = fixture(context);
  const timers = context.mock.method(globalThis, "setTimeout");
  const shell = await createShell(host.options);
  assert.equal(timers.mock.calls.length, 0, "idle roots must not start a polling timer");
  assert.equal(host.exitListeners.size, 1);
  const root = host.roots.get(shell.process.pid)!;
  const state = workerProcessState(root.transport);
  const result = claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
  for (const listener of host.exitListeners)
    listener({ pid: state.pid, parentPid: 0, job: state.job, result });
  assert.equal((await shell.done).code, 137);
  await shell.dispose();
  assert.equal(host.exitListeners.size, 0);
  assert.equal(host.terminated, 1);
});

test("internal adapter registration is reusable without fetching assets or admitting a shell", (context) => {
  const host = fixture(context);
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("Registration must remain lazy");
  };
  const registration = registerShell(host.runtime, host.options);
  assert.equal(registerShell(host.runtime, host.options), registration);
  assert.equal(fetches, 0);
  assert.equal(host.consumers.size, 0);
  assert.equal(host.requests.length, 0);
  assert.equal(host.reaped.length, 0);
  assert.deepEqual(runtimeSnapshot(host.runtime).roots, []);
  assert.equal(host.runtime.disposed, false);
});

test("a pre-aborted shell creates no registration or retained resources", async (context) => {
  const host = fixture(context);
  const controller = new AbortController();
  const reason = new Error("Embedding cancelled startup");
  controller.abort(reason);
  await assert.rejects(
    createShell({ ...host.options, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(host.adapters.size, 0);
  assert.equal(host.consumers.size, 0);
  assert.equal(host.reaped.length, 0);
  assert.equal(host.requests.length, 0);
});

test("aborting one pending shared fetch releases only its shell admission", async (context) => {
  const host = fixture(context);
  const controller = new AbortController();
  let enter!: () => void;
  const fetching = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let complete!: (response: Response) => void;
  globalThis.fetch = () => {
    enter();
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const reason = new Error("Embedding cancelled startup");
  const rejected = assert.rejects(
    createShell({ ...host.options, signal: controller.signal }),
    (error) => error === reason,
  );
  const sibling = createShell(host.options);
  await fetching;
  assert.equal(host.consumers.size, 2);
  controller.abort(reason);
  await rejected;
  assert.equal(host.consumers.size, 1);
  assert.equal(host.requests.length, 0);
  complete(new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)));
  const shell = await sibling;
  assert.equal(host.requests.length, 1);
  await shell.dispose();
  assert.equal(host.consumers.size, 0);
  assert.equal(host.runtime.disposed, false);
});

test("abort joins an in-flight broker admission before closing its filesystem identity", async (context) => {
  const host = fixture(context);
  const controller = new AbortController();
  let enter!: () => void;
  const adopting = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let complete!: () => void;
  const admitted = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const adopt = host.service.adoptRuntimeRoot.bind(host.service);
  host.service.adoptRuntimeRoot = async (transport, options) => {
    await adopt(transport, options);
    enter();
    await admitted;
  };
  const reason = new Error("Embedding cancelled admission");
  let settled = false;
  const pending = createShell({ ...host.options, signal: controller.signal });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(pending, (error) => error === reason);
  await adopting;
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(host.consumers.size, 1);
  assert.equal(host.events.includes("port-closed"), false);
  complete();
  await rejected;
  assert.deepEqual(host.rootStatuses, [137]);
  assert.equal(host.consumers.size, 0);
  assert.equal(host.requests.length, 0);
  assert.equal(host.runtime.disposed, false);
});

test("abort after worker admission waits for its fence and physical stop", async (context) => {
  const host = fixture(context, false, undefined, true);
  const controller = new AbortController();
  const reason = new Error("Embedding cancelled worker startup");
  const rejected = assert.rejects(
    createShell({ ...host.options, signal: controller.signal }),
    (error) => error === reason,
  );
  await host.posted;
  controller.abort(reason);
  await rejected;
  assert.equal(host.consumers.size, 0);
  assert.equal(host.terminated, 1);
  assert.ok(host.events.indexOf("fenced") < host.events.indexOf("terminated"));
  assert.equal(host.runtime.disposed, false);
});

for (const mode of ["host-policy", "host-default", "post-start", "exit126", "exit127"] as const) {
  test(`real host broker preserves adapter diagnostic policy: ${mode}`, async (testContext) => {
    const host = fixture(testContext);
    registerShell(host.runtime, host.options);
    const adapter = host.adapters.get("bash-web:preview1")!;
    const registry = new ExecutableRegistry();
    registry.register("fixture", {
      adapter: "bash-web:preview1",
      module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    });
    const output: string[] = [];
    const events: string[] = [];
    const errors: unknown[] = [];
    const startupError = Object.assign(new Error("guest has no _start entry point"), {
      code: "ENOEXEC",
    });
    let launched!: ProcessContext;
    const broker = new BrowserProcessBroker({
      identities: host.runtime.identities,
      table: new ProcessTable(host.runtime.identities),
      registry,
      onError: (error) => errors.push(error),
      filesystem: {
        connect() {
          throw new Error("No filesystem connection in this controller fixture");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch(context) {
        const transport = createWorkerProcessTransport({
          pid: context.pid,
          job: context.job,
          identity: host.runtime.identities.buffer,
          capacity: 4,
        });
        transport.data = { filesystem: createFilesystemIdentity(undefined, 1024 * 1024) };
        const service = {
          transportFor: () => transport,
          registerController(pid: number, controller: ProcessController) {
            assert.equal(pid, context.pid);
            assert.equal(typeof controller.startFailed, "function");
            events.push("controller");
            const startFailed = controller.startFailed!;
            broker.registerController(pid, {
              ...controller,
              // This host spawn has no runtime_proc parent; bypass policy to prove its
              // unchanged generic writer still runs, unlike an admitted runtime child.
              startFailed:
                mode === "host-default"
                  ? undefined
                  : (error, active) => {
                      assert.equal(error, startupError);
                      assert.equal(active(), true);
                      events.push("startup-diagnostic");
                      return startFailed(error, active);
                    },
            });
          },
          launchWorker(child: ProcessContext, options: WorkerLaunchOptions<ShellWorkerRequest>) {
            assert.deepEqual(events, ["controller"]);
            events.push("launch");
            launched = child;
            return { terminate: () => options.cleanup?.() };
          },
        } as unknown as ProcessService;
        return adapter({ ...context, identity: createProcessIdentity(context) }, service);
      },
    });
    try {
      const supervisor = await broker.ready();
      const descriptors = new DescriptorTable();
      const write = (chunks: readonly Uint8Array[]) => {
        for (const chunk of chunks) output.push(new TextDecoder().decode(chunk));
        return chunks.reduce((size, chunk) => size + chunk.length, 0);
      };
      descriptors.openAt(
        2,
        {
          kind: "terminal",
          read: () => 0,
          write,
          tryWrite: write,
          readiness: () => ({ readable: false, writable: true, hangup: false }),
        },
        1n << 6n,
        0n,
      );
      const root = supervisor.createRoot({ descriptors });
      const pid = supervisor.reserveSpawn(root, {
        executable: "fixture",
        argv: ["fixture"],
        env: {},
        cwd: "/",
        job: -1,
        fds: [{ parent: 2, child: 2 }],
      });
      await supervisor.start(pid);
      assert.deepEqual(errors, []);
      assert.deepEqual(events, ["controller", "launch"]);
      const startup = mode === "host-policy" || mode === "host-default";
      if (!startup) assert.equal(launched.started(), true);
      const stderr = launched.descriptors.get(2)!.resource;
      assert.ok(stderr.kind === "terminal");
      assert.equal(stderr.write([new TextEncoder().encode("GUEST_STDERR\n")]), 13);
      if (startup) launched.startFailed(startupError);
      else if (mode === "post-start") launched.fail(new Error("guest execution failed"));
      else launched.exit(mode === "exit127" ? 127 : 126);
      // Guest ABI uses WASI 45; the typed host outcome retains Linux ENOEXEC 8.
      assert.equal(supervisor.startStatus(root, pid), startup ? 45 : 0);
      const result = await supervisor.waitForExit(root, pid);
      assert.deepEqual(
        result,
        startup
          ? { kind: "start-failed", error: "ENOEXEC", code: 8, status: null }
          : {
              kind: "exited",
              code: mode === "exit127" ? 127 : 126,
              status: mode === "exit127" ? 127 : 126,
            },
      );
      assert.deepEqual(
        events,
        mode === "host-policy"
          ? ["controller", "launch", "startup-diagnostic"]
          : ["controller", "launch"],
      );
      assert.equal(
        output.join(""),
        mode === "host-default"
          ? `GUEST_STDERR\nruntime: process start failed: ${String(startupError)}\n`
          : "GUEST_STDERR\n",
      );
      assert.deepEqual(errors, []);
    } finally {
      await broker.dispose();
    }
    assert.equal(host.consumers.size, 0);
  });
}

test("the shell adapter forwards source admission instrumentation to the worker bootstrap", async (testContext) => {
  const host = fixture(testContext);
  registerShell(host.runtime, host.options);
  const adapter = host.adapters.get("bash-web:preview1")!;
  const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  for (const interruptible of [false, true]) {
    const pid = host.runtime.identities.pid();
    const transport = createWorkerProcessTransport({
      pid,
      job: host.runtime.identities.job(),
      identity: host.runtime.identities.buffer,
      capacity: 4,
    });
    transport.data = { filesystem: createFilesystemIdentity(undefined, 1024 * 1024) };
    const launches: WorkerLaunchOptions<ShellWorkerRequest>[] = [];
    const service = {
      transportFor() {
        return transport;
      },
      registerController() {},
      launchWorker(_context: ProcessContext, options: WorkerLaunchOptions<ShellWorkerRequest>) {
        launches.push(options);
        return { terminate() {} };
      },
    } as unknown as ProcessService;
    const context = {
      pid,
      module,
      interruptible,
      request: { argv: ["/bin/test-spin"], env: {}, cwd: "/home/guest" },
    } as unknown as ProcessContext;
    await adapter({ ...context, identity: createProcessIdentity({ pid, parentPid: 0 }) }, service);
    const launched = launches[0];
    assert.equal(launched?.request.interruptible, interruptible);
    assert.equal(launched?.request.module, module);
    launched?.cleanup?.();
    assert.equal(host.consumers.size, 0);
  }
});

test("foreign terminal output drops are surfaced in runtime diagnostics", async (context) => {
  const host = fixture(context);
  const terminal = new SharedBridge();
  const error = context.mock.method(console, "error", () => {});
  const shell = await createShell({ ...host.options, terminal });
  const root = host.roots.get(shell.process.pid)!;
  const bytes = new Uint8Array(OUTPUT_CAPACITY + 1).fill(19);
  root.options.output!(1, bytes);
  assert.equal(runtimeSnapshot(host.runtime).droppedTerminalBytes, 1);
  assert.equal(runtimeSnapshot(host.runtime).roots[0]!.droppedTerminalBytes, 1);
  assert.deepEqual(terminal.drain(OUTPUT_CAPACITY + 1), bytes.subarray(0, OUTPUT_CAPACITY));
  assert.deepEqual(
    Array.from(error.mock.calls, (call) => call.arguments),
    [["bash-web terminal output dropped 1 bytes on fd 1"]],
  );
  await shell.dispose();
  assert.equal(runtimeSnapshot(host.runtime).droppedTerminalBytes, 1);
});

test("shell facades borrow one page runtime and dispose only their own process tree", async (context) => {
  const host = fixture(context);
  const first = await createShell({ ...host.options, script: "echo first" });
  const second = await createShell({ ...host.options, script: "echo second" });
  assert.notEqual(first.process.pid, second.process.pid);
  assert.equal(host.consumers.size, 2);
  assert.equal(runtimeSnapshot(host.runtime).roots.length, 2);
  await first.dispose();
  assert.equal(host.runtime.disposed, false);
  assert.equal(host.ownerDisposals, 0);
  assert.equal(host.consumers.size, 1);
  assert.equal(host.terminated, 1);
  assert.equal(runtimeSnapshot(host.runtime).roots[0]!.pid, second.process.pid);
  assert.ok(host.events.indexOf("fenced") < host.events.indexOf("terminated"));
  await second.dispose();
  assert.equal(host.consumers.size, 0);
  assert.equal(host.terminated, 2);
});

test("direct terminal child gets owned output and cleanup stays behind its fence", async (context) => {
  const host = fixture(context);
  let releaseFence!: () => void;
  const fence = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  let disposal: Promise<void> | undefined;
  let sibling: Awaited<ReturnType<typeof createShell>> | undefined;
  const descriptors = new DescriptorTable();
  try {
    const shell = await createShell(host.options);
    sibling = await createShell(host.options);
    const rootRequest = host.requests[0] as ShellWorkerRequest;
    const rootTransport = rootRequest.runtimeProcess!;
    let child!: WorkerProcessTransport;
    const unexpected = (): never => {
      throw new Error("No descriptor transfer in this fixture");
    };
    const client = new WorkerProcessClient({
      transport: rootTransport,
      descriptors,
      codec: { import: unexpected, export: unexpected, discard: unexpected },
      postMessage(message) {
        if (message.operation === "spawn") child = message.transport;
      },
    });
    const request = {
      executable: "/bin/child",
      argv: ["child"],
      env: {},
      cwd: "/home/guest",
      job: -1,
      fds: [],
    };
    const pid = client.spawn(shell.process.pid, request);
    const childFilesystem = createFilesystemIdentity(undefined, 1024 * 1024);
    const metadata = rootTransport.data;
    assert.ok(
      metadata &&
        typeof metadata === "object" &&
        "terminalContext" in metadata &&
        "terminalInput" in metadata,
    );
    child.data = {
      filesystem: childFilesystem,
      terminalContext: metadata.terminalContext,
      terminalInput: metadata.terminalInput,
    };
    let terminateChild!: () => Promise<void>;
    let stopped = false;
    const childService = {
      transportFor() {
        return child;
      },
      registerController() {},
      launchWorker(_context: ProcessContext, options: WorkerLaunchOptions<ShellWorkerRequest>) {
        assert.equal(options.request.shellOutput, rootRequest.terminal);
        terminateChild = async () => {
          await fence;
          stopped = true;
          options.cleanup?.();
        };
        return { terminate: terminateChild };
      },
    } as unknown as ProcessService;
    launchTerminalWorker<ShellWorkerRequest>(
      host.runtime,
      childService,
      {
        pid,
        module: rootRequest.module,
        interruptible: false,
        request,
      } as unknown as ProcessContext,
      {
        workerUrl: host.options.workerUrl,
        request: { module: rootRequest.module, args: request.argv, env: request.env },
      },
    );
    const kill = host.service.killJob.bind(host.service);
    host.service.killJob = async (job, signal, reserved) => {
      await kill(job, signal, reserved);
      if (job === workerProcessState(child).job) void terminateChild();
    };
    let settled = false;
    disposal = shell.dispose();
    void disposal.then(() => {
      settled = true;
    });
    await host.firstRelease;
    assert.equal(settled, false);
    assert.equal(stopped, false);
    assert.equal(host.terminated, 1);
    assert.equal(host.consumers.size, 2); // Child plus the unrelated second shell.
    releaseFence();
    await disposal;
    assert.equal(stopped, true);
    assert.equal(host.consumers.size, 1);
    assert.equal(host.runtime.disposed, false);
    assert.equal(host.terminated, 1);
  } finally {
    releaseFence();
    await disposal;
    await sibling?.dispose();
    descriptors.dispose();
  }
});

test("worker construction failure retires the fork without disposing its owner", async (context) => {
  const host = fixture(context, true);
  await assert.rejects(createShell(host.options), /Worker construction refused/);
  assert.equal(host.runtime.disposed, false);
  assert.equal(host.ownerDisposals, 0);
  assert.equal(host.reaped.length, 1);
  assert.equal(host.consumers.size, 0);
  assert.deepEqual(runtimeSnapshot(host.runtime).roots, []);
  assert.ok(host.events.includes("port-closed"));
});

test("page disposal retains a lazy shell consumer until its owner fences and stops it", async (context) => {
  const host = fixture(context);
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: (response: Response) => void;
  globalThis.fetch = () => {
    entered();
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const pending = createShell(host.options);
  // Observe startup rejection before page disposal can select its logical outcome.
  const rejected = assert.rejects(pending, /Runtime is disposed/);
  await fetching;
  assert.equal(host.consumers.size, 1);
  await host.runtime.dispose();
  assert.ok(host.events.indexOf("owner-fenced") < host.events.indexOf("port-closed"));
  complete(new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)));
  await rejected;
  assert.equal(host.borrowedAfterDispose, 0);
  assert.equal(host.requests.length, 0);
  assert.equal(host.consumers.size, 0);
});

test("an unobserved cached registration reports work first started by an observed shell", async (context) => {
  const host = fixture(context);
  registerShell(host.runtime, host.options);
  const diagnostics = createStartupDiagnostics(1);
  const shell = await createShell({ ...host.options, onStartupStage: diagnostics.observe });
  try {
    for (const stage of [
      "shell-home-mkdir-requested",
      "shell-home-mkdir-resolved",
      "shell-wasm-fetch-requested",
      "shell-wasm-fetch-resolved",
      "shell-wasm-compile-resolved",
    ] as const)
      assert.notEqual(diagnostics.snapshot().stages[stage], undefined, stage);
    assert.deepEqual(diagnostics.snapshot().pending, []);
  } finally {
    await shell.dispose();
  }
});

for (const failed of ["fetch", "mkdir"] as const)
  test(`a new start observes a new shared ${failed} attempt, not the stopped generation`, async (context) => {
    const host = fixture(context);
    let attempts = 0;
    if (failed === "fetch")
      globalThis.fetch = async () =>
        ++attempts === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    else
      host.runtime.filesystem.mkdirp = async () => {
        if (++attempts === 1) throw new Error("Directory initialization failed");
      };
    const previous = createStartupDiagnostics(1);
    await assert.rejects(
      createShell({ ...host.options, onStartupStage: previous.observe }),
      failed === "fetch" ? /Shell executable fetch failed/ : /Directory initialization failed/,
    );
    previous.stop();
    const stopped = previous.snapshot();
    const next = createStartupDiagnostics(2);
    const shell = await createShell({ ...host.options, onStartupStage: next.observe });
    try {
      const operation = failed === "fetch" ? "shell-wasm-fetch" : "shell-home-mkdir";
      assert.notEqual(next.snapshot().stages[`${operation}-requested`], undefined);
      assert.notEqual(next.snapshot().stages[`${operation}-resolved`], undefined);
      assert.deepEqual(next.snapshot().pending, []);
      assert.deepEqual(previous.snapshot(), stopped);
      if (failed === "fetch") {
        assert.equal(attempts, 2);
        assert.equal(next.snapshot().stages["shell-home-mkdir-requested"], undefined);
      }
    } finally {
      await shell.dispose();
    }
  });

test("a live borrowed runtime does not retain disposed no-observer shell options", async (context) => {
  const host = fixture(context);
  const gc = globalThis.gc;
  assert.ok(gc, "The runtime unit runner must enable --expose-gc");
  const references = await (async () => {
    const terminal = new SharedBridge();
    const env = { GC_PROBE: "original environment" };
    const signal = new AbortController().signal;
    const options = { ...host.options, terminal, env, signal };
    const references = {
      options: new WeakRef(options),
      terminal: new WeakRef(terminal),
      env: new WeakRef(env),
      signal: new WeakRef(signal),
    };
    const shell = await createShell(options);
    await shell.dispose();
    return references;
  })();
  assert.equal(host.consumers.size, 0);
  assert.equal(host.roots.size, 0);
  assert.equal(host.runtime.disposed, false);
  // WeakRef construction keeps targets alive for that job. Collect on later turns;
  // do not dereference between collections, which would keep a target alive again.
  for (let pass = 0; pass < 8; pass++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
  }
  for (const [name, reference] of Object.entries(references))
    assert.equal(reference.deref() === undefined, true, `${name} retained after shell disposal`);
  assert.equal(host.runtime.disposed, false);
});

for (const stalled of ["mkdir", "fetch"] as const)
  test(`startup diagnostics name a stalled ${stalled} without marking it resolved`, async (context) => {
    const host = fixture(context);
    const diagnostics = createStartupDiagnostics(1);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (stalled === "mkdir")
      host.runtime.filesystem.mkdirp = async () => {
        entered();
        await held;
      };
    else
      globalThis.fetch = async () => {
        entered();
        await held;
        return new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
      };
    const pending = createShell({ ...host.options, onStartupStage: diagnostics.observe });
    try {
      await waiting;
      const stage =
        stalled === "mkdir" ? "shell-home-mkdir-requested" : "shell-wasm-fetch-requested";
      const completion =
        stalled === "mkdir" ? "shell-home-mkdir-resolved" : "shell-wasm-fetch-resolved";
      assert.equal(diagnostics.snapshot().last?.stage, stage);
      assert.ok(diagnostics.snapshot().pending.includes(stage));
      assert.equal(diagnostics.snapshot().stages[completion], undefined);
      if (stalled === "mkdir")
        assert.equal(diagnostics.snapshot().stages["shell-wasm-fetch-requested"], undefined);
    } finally {
      release();
      await (await pending).dispose();
    }
  });

test("startup observer throws and rejections cannot change shell ownership or readiness", async (context) => {
  const host = fixture(context);
  let calls = 0;
  const shell = await createShell({
    ...host.options,
    onStartupStage() {
      if (++calls % 2) throw new Error("diagnostic observer");
      return Promise.reject(new Error("diagnostic observer"));
    },
  });
  assert.ok(calls > 10);
  assert.equal(host.consumers.size, 1);
  await shell.dispose();
  assert.equal(host.consumers.size, 0);
  assert.equal(host.ownerDisposals, 0);
});

test("a borrowed runtime with cached registration does not synthesize earlier startup stages", async (context) => {
  const host = fixture(context);
  const first = await createShell(host.options);
  await first.dispose();
  const diagnostics = createStartupDiagnostics(2);
  const second = await createShell({ ...host.options, onStartupStage: diagnostics.observe });
  assert.equal(diagnostics.snapshot().stages["shell-home-mkdir-requested"], undefined);
  assert.equal(diagnostics.snapshot().stages["shell-wasm-fetch-requested"], undefined);
  assert.ok(diagnostics.snapshot().stages["shell-registration-resolved"]);
  assert.deepEqual(diagnostics.snapshot().pending, []);
  await second.dispose();
});
