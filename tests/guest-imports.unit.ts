// Shell metadata regressions. Bun guest libc/host-slot internals are tested by bun-wasm.
import assert from "node:assert/strict";
import { bootstrap, type RuntimeWorkerMessage } from "waffle/browser/worker";
import { createFilesystemConnection } from "waffle/fs";
import {
  createWorkerProcessTransport,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { shellExecutor, type ShellWorkerRequest } from "../src/runtime/worker";
import { test, type TestContext } from "node:test";
import { MAX_DESCRIPTOR } from "waffle/core/descriptors";
import { SharedBridge, control } from "../src/bridge";
import { shellTerminalImports } from "../src/runtime/guest-imports";
import { createTerminalProducer } from "../src/runtime/terminal-producer";
function ownTerminal(owner: TestContext, transport: WorkerProcessTransport) {
  const producer = createTerminalProducer({
    controller: transport,
    geometry: { columns: 80, rows: 24 },
    checkActive() {},
  });
  owner.after(() => producer.dispose());
  return producer;
}

test("shell terminal columns follow the live bridge and default to 80 for a child", () => {
  const bridge = new SharedBridge();
  const root = shellTerminalImports(bridge.buffer);
  Atomics.store(bridge.state, control.cols, 103);
  assert.equal(root.columns(), 103);
  Atomics.store(bridge.state, control.cols, 0);
  assert.equal(root.columns(), 2);
  assert.equal(shellTerminalImports().columns(), 80);
});

test("shell metadata enumerates exact inherited bindings, including the maximum fd", () => {
  assert.equal(
    MAX_DESCRIPTOR,
    0x7fffffff,
    "the signed metadata sentinel must stay outside the fd domain",
  );
  const inherited = [0, 1, 2, 3, 4, 1000000, MAX_DESCRIPTOR];
  const imports = shellTerminalImports(undefined, inherited);
  assert.deepEqual(
    Array.from({ length: inherited.length }, (_, index) => imports.inherited_fd(index)),
    inherited,
  );
  assert.equal(imports.inherited_fd(inherited.length), -1);
  // The -1 sentinel is outside the runtime's descriptor domain (MAX_DESCRIPTOR=0x7fffffff).
  assert.equal(imports.inherited_fd(inherited.length - 1), 0x7fffffff);
});

test("shell metadata distinguishes an empty binding list from default root stdio", () => {
  assert.equal(shellTerminalImports(undefined, []).inherited_fd(0), -1);
  const root = shellTerminalImports();
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => root.inherited_fd(index)),
    [0, 1, 2, -1],
  );
});

test("production worker keeps terminal stdio for an empty root transport but not an empty child", async (owner) => {
  // Original probe: an empty _start and memory, plus an exported shell_terminal import.
  // Calling the export observes the real Wasm linker/namespace wiring, not source text.
  const module = new WebAssembly.Module(
    Uint8Array.of(
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      9,
      2,
      96,
      1,
      127,
      1,
      127,
      96,
      0,
      0,
      2,
      31,
      1,
      14,
      115,
      104,
      101,
      108,
      108,
      95,
      116,
      101,
      114,
      109,
      105,
      110,
      97,
      108,
      12,
      105,
      110,
      104,
      101,
      114,
      105,
      116,
      101,
      100,
      95,
      102,
      100,
      0,
      0,
      3,
      2,
      1,
      1,
      5,
      3,
      1,
      0,
      1,
      7,
      34,
      3,
      6,
      95,
      115,
      116,
      97,
      114,
      116,
      0,
      1,
      6,
      109,
      101,
      109,
      111,
      114,
      121,
      2,
      0,
      12,
      105,
      110,
      104,
      101,
      114,
      105,
      116,
      101,
      100,
      95,
      102,
      100,
      0,
      0,
      10,
      4,
      1,
      2,
      0,
      11,
    ),
  );
  for (const mode of ["root", "child", "redirected"] as const) {
    const connection = createFilesystemConnection();
    try {
      const bridge = new SharedBridge();
      const transport = createWorkerProcessTransport();
      const producer = ownTerminal(owner, transport);
      // A child can know its terminal destination without inheriting any descriptor.
      transport.data = { ...producer.rootMetadata, shellTerminal: bridge.buffer };
      if (mode === "redirected") {
        transport.resources = [{ kind: "web-terminal", target: 1 }];
        transport.bindings = [1, 3, MAX_DESCRIPTOR].map((fd) => ({
          fd,
          reference: 0,
          rightsBase: 1n << 6n,
          rightsInheriting: 0n,
        }));
      }
      const request: ShellWorkerRequest = {
        module,
        args: ["stdio-probe"],
        env: {},
        filesystem: connection.client,
        runtimeProcess: transport,
        terminal: mode === "root" ? bridge.buffer : undefined,
      };
      const executor = shellExecutor(request);
      const messages: RuntimeWorkerMessage[] = [];
      const observed: { inherited: number[]; stdio: (string | null)[]; wrote: boolean }[] = [];
      const output = Uint8Array.of(0, 255, 13, 10);
      await bootstrap(
        request,
        {
          ...executor,
          setup(context) {
            // This probe never touches files. Keep only root-preopen bookkeeping local:
            // a synchronous filesystem service cannot answer itself on this test thread.
            context.fs.preopen = () => 1;
            context.fs.retain = () => {};
            context.fs.release = () => {};
            executor.setup?.(context);
          },
          instantiated(context) {
            executor.instantiated?.(context);
            const inherited = context.instance.exports.inherited_fd as (index: number) => number;
            observed.push({
              inherited: Array.from({ length: 4 }, (_, index) => inherited(index)),
              stdio: [0, 1, 2].map((fd) => context.wasi.descriptors.get(fd)?.resource.kind ?? null),
              wrote: context.post("stdout", output),
            });
          },
        },
        {
          crossOriginIsolated: true,
          postMessage(message) {
            messages.push(message);
          },
        },
      );
      assert.equal(observed.length, 1, `${mode}: guest must instantiate and run`);
      assert.deepEqual(
        observed[0],
        mode === "root"
          ? {
              inherited: [0, 1, 2, -1],
              stdio: ["terminal", "terminal", "terminal"],
              wrote: true,
            }
          : mode === "child"
            ? {
                inherited: [-1, -1, -1, -1],
                stdio: [null, null, null],
                wrote: false,
              }
            : {
                inherited: [1, 3, MAX_DESCRIPTOR, -1],
                stdio: [null, "terminal", null],
                wrote: true,
              },
        mode,
      );
      assert.deepEqual(bridge.drain(), mode === "child" ? new Uint8Array() : output, mode);
      assert.deepEqual(
        messages.filter((message) => message.type === "exit"),
        [{ type: "exit", code: 0, signal: undefined, sleep: "atomics" }],
        mode,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.type === "stdout" ||
            message.type === "stderr" ||
            message.type === "error" ||
            message.type === "cleanup-error",
        ),
        false,
        mode,
      );
    } finally {
      connection.client.port.close();
      connection.server.port.close();
    }
  }
});

test("prompt publication stores shell status before ready and wakes repeated ready prompts", () => {
  const bridge = new SharedBridge();
  const root = shellTerminalImports(bridge.buffer);
  root.phase(2, 0);
  root.phase(1, 1);
  assert.equal(Atomics.load(bridge.state, control.phase), 1);
  assert.equal(Atomics.load(bridge.state, control.status), 1);
  const wake = Atomics.load(bridge.state, control.wake);
  root.phase(1, 130);
  assert.equal(Atomics.load(bridge.state, control.status), 130);
  assert.ok(Atomics.load(bridge.state, control.wake) > wake);
  root.phase(2, 42);
  assert.equal(Atomics.load(bridge.state, control.status), 130);
  shellTerminalImports().phase(1, 7);
  assert.equal(Atomics.load(bridge.state, control.status), 130);
  bridge.close();
  root.phase(1, 0);
  assert.equal(Atomics.load(bridge.state, control.status), 130);
});
