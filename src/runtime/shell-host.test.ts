// Original facade lifetime regressions. Waffle's real identity/connection protocol is used;
// only browser workers and the page's already-owned service capabilities are stubbed.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ProcessService, Runtime, RuntimeConsumer } from "waffle";
import type { RuntimeRootOptions, WorkerLaunchOptions } from "waffle/browser/process-broker";
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
        if (!disposed) consumers.delete(consumer);
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
    await adapter(context, service);
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

test("facade disposal joins its adapter child cleanup behind a held fence, not another shell", async (context) => {
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
    child.data = { filesystem: createFilesystemIdentity(undefined, 1024 * 1024) };
    let terminateChild!: () => Promise<void>;
    let stopped = false;
    const childService = {
      transportFor() {
        return child;
      },
      registerController() {},
      launchWorker(_context: ProcessContext, options: WorkerLaunchOptions<ShellWorkerRequest>) {
        terminateChild = async () => {
          await fence;
          stopped = true;
          options.cleanup?.();
        };
        return { terminate: terminateChild };
      },
    } as unknown as ProcessService;
    await host.adapters.get("bash-web:preview1")!(
      {
        pid,
        module: rootRequest.module,
        interruptible: false,
        request,
      } as unknown as ProcessContext,
      childService,
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
    await new Promise<void>((resolve) => setImmediate(resolve));
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
