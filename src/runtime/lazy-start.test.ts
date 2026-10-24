// Original regression: real runtime_proc admission must stay quiet before adapter launch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { DescriptorTable } from "waffle/core/descriptors";
import { createFilesystemIdentity } from "waffle/fs/protocol";
import { ProcessIdentityAllocator } from "waffle/proc/identity";
import { PipeController, type PipeEndpoint } from "waffle/proc/pipes";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessTable } from "waffle/proc/table";
import type { ProcessExit } from "waffle/proc/types";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "waffle/proc/worker-client";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";

async function verifyRuntimeChild(
  parent: WorkerProcessClient,
  pid: number,
  {
    output,
    reader,
    errors,
    failure,
    outcome,
    notices,
    broker,
  }: {
    output: readonly string[];
    reader: PipeEndpoint;
    errors: readonly unknown[];
    failure: WebAssembly.CompileError;
    outcome: ProcessExit;
    notices: readonly WorkerProcessMessage[];
    broker: BrowserProcessBroker;
  },
): Promise<void> {
  const parentPid = parent.pid;
  assert.equal(parent.startStatus(parentPid, pid), 45);
  assert.equal(output.join(""), "", "runtime_proc child emitted generic terminal bytes");
  assert.equal(reader.tryRead([new Uint8Array(1024)]), 0, "child stderr must reach clean EOF");
  assert.equal(errors.length, 1, "the host retains exactly one full diagnostic");
  assert.ok(errors[0] instanceof Error);
  assert.equal(errors[0].cause, failure, "the host must retain the original compile failure");
  assert.ok(errors[0].stack);
  const job = parent.jobOf(pid);
  assert.deepEqual(parent.wait(parentPid, pid), outcome, "process cleanup must be confirmed");
  assert.ok(parent.waitJob(parentPid, job), "job cleanup must be confirmed");
  for (const notice of notices.slice(1)) await broker.runtimeMessage(notice, parentPid);
}

for (const mode of ["runtime-terminal", "runtime-pipe", "host-root"] as const) {
  test(`lazy loader diagnostic ownership: ${mode}`, async () => {
    const identities = new ProcessIdentityAllocator();
    const table = new ProcessTable(identities);
    let metadata = 0;
    const registry = new ExecutableRegistry(async (path) => {
      metadata++;
      return { path, kind: "file" };
    });
    const failure = new WebAssembly.CompileError("review loader failure");
    let loads = 0;
    let launches = 0;
    registry.register("/bin/lazy-failure", {
      adapter: "must-not-launch",
      module() {
        loads++;
        throw failure;
      },
    });
    const output: string[] = [];
    const errors: unknown[] = [];
    const notices: WorkerProcessMessage[] = [];
    const broker = new BrowserProcessBroker({
      identities,
      table,
      registry,
      onError: (error) => errors.push(error),
      filesystem: {
        connect() {
          throw new Error("A rejected loader cannot acquire a filesystem connection");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch() {
        launches++;
        throw new Error("A rejected loader cannot enter the adapter");
      },
    });
    const descriptors = new DescriptorTable();
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
      capacity: 4,
    });
    root.data = { filesystem: createFilesystemIdentity(undefined, 1024 * 1024) };
    const pipe = new PipeController({ capacity: 1024, relay: "manual" });
    const reader = pipe.retain(root.pid, "read");
    const write = (chunks: readonly Uint8Array[]) => {
      for (const chunk of chunks) output.push(new TextDecoder().decode(chunk));
      return chunks.reduce((total, chunk) => total + chunk.length, 0);
    };
    descriptors.openAt(
      2,
      mode === "runtime-pipe"
        ? pipe.retain(root.pid, "write")
        : {
            kind: "terminal",
            read: () => 0,
            write,
            tryWrite: write,
            readiness: () => ({ readable: false, writable: true, hangup: false }),
          },
      64n,
      0n,
    );
    try {
      await registry.check("/bin/lazy-failure");
      assert.equal(loads, 0, "metadata admission must not invoke the lazy loader");
      const request = {
        executable: "/bin/lazy-failure",
        argv: ["lazy-failure"],
        env: {},
        cwd: "/",
        job: -1,
        fds: [{ parent: 2, child: 2 }],
      };
      const supervisor = await broker.ready();
      let parent: WorkerProcessClient | undefined;
      let parentPid: number;
      let pid: number;
      if (mode === "host-root") {
        parentPid = await broker.adoptRoot({ descriptors });
        pid = supervisor.reserveSpawn(parentPid, request);
      } else {
        await broker.adoptRuntimeRoot(root, {
          output: (_fd, bytes) => output.push(new TextDecoder().decode(bytes)),
        });
        parent = new WorkerProcessClient({
          transport: root,
          descriptors,
          codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
          prepareSpawn: () => ({
            data: { filesystem: createFilesystemIdentity(undefined, 1024 * 1024) },
          }),
          postMessage: (notice) => notices.push(notice),
        });
        parentPid = parent.pid;
        pid = parent.spawn(parentPid, request);
        descriptors.dispose();
        assert.equal(notices.length, 1);
        for (const notice of notices) await broker.runtimeMessage(notice, parentPid);
      }
      await supervisor.start(pid);
      const outcome = await supervisor.waitForExit(parentPid, pid);
      assert.ok(metadata >= 2);
      assert.equal(loads, 1);
      assert.equal(launches, 0);
      assert.equal(supervisor.startStatus(parentPid, pid), 45);
      assert.deepEqual(outcome, {
        kind: "start-failed",
        error: "ENOEXEC",
        code: 8,
        status: null,
      });
      if (parent) {
        await verifyRuntimeChild(parent, pid, {
          output,
          reader,
          errors,
          failure,
          outcome,
          notices,
          broker,
        });
      } else {
        assert.equal(broker.transportFor(pid), undefined);
        assert.equal(table.get(pid)!.parentPid, parentPid);
        assert.equal(
          output.join(""),
          "runtime: process start failed: Error: review loader failure\n",
        );
        assert.deepEqual(errors, [], "host roots keep their existing stderr reporting policy");
      }
    } finally {
      descriptors.dispose();
      reader.close();
      try {
        await broker.dispose();
      } finally {
        pipe.dispose();
      }
    }
  });
}
