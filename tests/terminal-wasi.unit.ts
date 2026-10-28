import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const { build } = createRequire(resolve(process.cwd(), "package.json"))(
  "esbuild",
) as typeof import("esbuild");
import type { Wasi, Descriptor } from "waffle/core";
import { terminalGuest } from "./helpers/terminal-wasi-guest";
import { PipeController } from "waffle/proc/pipes";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { SharedBridge, control, OUTPUT_CAPACITY } from "../src/bridge";
import { createBridgeTerminal } from "../src/runtime/runtime-terminals";
import {
  attachTerminal,
  createTerminalAdmission,
  revokeTerminal,
} from "../src/runtime/terminal-admission";

function terminalCodec(
  bridge: SharedBridge,
  descriptors?: Wasi["descriptors"],
  admission = createTerminalAdmission(),
) {
  const unsupported = (): never => {
    throw new Error("unexpected nonterminal token");
  };
  return createRuntimeTerminalCodec({
    fallback: { import: unsupported, export: unsupported, discard: unsupported },
    descriptors,
    resolveTerminal: (target) => createBridgeTerminal(bridge.buffer, target, undefined, admission),
  });
}
function importBinding(
  guest: ReturnType<typeof terminalGuest>,
  fd: number,
  source: Descriptor,
  token: unknown,
  codec: ReturnType<typeof terminalCodec>,
) {
  const description = codec.import(token, 20);
  guest.wasi.descriptors.inherit(fd, { ...source, description, resource: description.resource });
}

test("real WASI reads inherited fd2 keys beside pipe content, with remapping and descriptor rights", (context) => {
  const bridge = new SharedBridge();
  const parent = terminalGuest({
    1: createBridgeTerminal(bridge.buffer, 1),
    2: createBridgeTerminal(bridge.buffer, 2),
  });
  const child = terminalGuest();
  const pipe = new PipeController({ capacity: 64, relay: "manual" });
  context.after(() => {
    child.wasi.descriptors.dispose();
    parent.wasi.descriptors.dispose();
    pipe.dispose();
  });
  const exporter = terminalCodec(bridge, parent.wasi.descriptors);
  const controller = createRuntimeTerminalCodec({
    fallback: {
      import() {
        throw new Error("unexpected token");
      },
      export() {
        throw new Error("unexpected token");
      },
      discard() {
        throw new Error("unexpected token");
      },
    },
  });
  const source = parent.wasi.descriptors.get(2)!;
  assert.notEqual(source.rightsBase & 2n, 0n, "actual default TTY rights include FD_READ");
  const page = terminalGuest();
  context.after(() => page.wasi.descriptors.dispose());
  importBinding(page, 77, source, exporter.export(source, 20), controller);
  const token = controller.export(page.wasi.descriptors.get(77)!, 21);
  assert.deepEqual(token, { kind: "web-terminal", target: 2 });
  const importer = terminalCodec(bridge);
  importBinding(child, 2, source, token, importer);
  importBinding(child, 77, source, token, importer);
  importBinding(
    child,
    1,
    parent.wasi.descriptors.get(1)!,
    exporter.export(parent.wasi.descriptors.get(1)!, 20),
    importer,
  );
  const reader = pipe.retain(20, "read"),
    writer = pipe.retain(21, "write");
  context.after(() => writer.close());
  child.wasi.descriptors.close(0);
  child.wasi.descriptors.openAt(0, reader, 2n, 0n);
  const content = Uint8Array.of(99, 13, 10, 0, 255);
  assert.equal(writer.tryWrite([content]), content.length);
  assert.equal(child.io("fd_read", 0), 0);
  assert.deepEqual(child.bytes.slice(256, 261), content);
  assert.equal(
    bridge.send(Uint8Array.of(27, 91, 65, 0, 255)),
    Uint8Array.of(27, 91, 65, 0, 255).length,
  );
  assert.equal(child.io("fd_read", 2, 3), 0);
  assert.deepEqual(child.bytes.slice(256, 259), Uint8Array.of(27, 91, 65));
  assert.deepEqual(child.poll(2), { error: 0, nbytes: 2n, flags: 0 });
  assert.equal(child.io("fd_read", 77, 2), 0);
  assert.deepEqual(child.bytes.slice(256, 258), Uint8Array.of(0, 255));
  assert.equal(bridge.availableInput(), 0);
  const endpoint = child.wasi.descriptors.get(2)!.resource;
  assert.ok(endpoint.kind === "terminal");
  endpoint.fdflags = 4;
  assert.equal(child.io("fd_read", 2), 6);
  assert.equal(endpoint.readiness().readable, false);
  assert.equal(child.io("fd_write", 2, 2), 0);
  assert.deepEqual(bridge.drain(), Uint8Array.of(0, 255));
  bridge.send(Uint8Array.of(9));
  child.wasi.descriptors.get(77)!.rightsBase &= ~2n;
  assert.equal(child.io("fd_read", 77), 76);
  assert.equal(bridge.availableInput(), 1);
  assert.equal(child.io("fd_read", 1, 1), 0);
  assert.equal(child.bytes[256], 9);
  const writeOnly = pipe.retain(22, "write");
  child.wasi.descriptors.openAt(88, writeOnly, 64n, 0n);
  assert.equal(child.io("fd_read", 88), 76);
  assert.equal(writeOnly.tryRead([new Uint8Array(1)]), -8);
  child.fs.writeFile("/redirected", Uint8Array.of(0, 255));
  const path = child.fs.resolve(child.fs.preopen("/"), "redirected");
  assert.ok(typeof path !== "number" && path.node !== undefined);
  if (typeof path === "number" || path.node === undefined) throw new Error("missing file");
  const handle = path.node;
  child.fs.retain(handle);
  child.wasi.descriptors.openAt(
    89,
    { kind: "file", handle, offset: 0, append: false },
    64n,
    0n,
    () => child.fs.release(handle),
  );
  assert.equal(child.io("fd_read", 89), 76);
  assert.equal(child.io("fd_write", 89, 1), 0);
  bridge.close();
  assert.deepEqual(child.poll(2), { error: 0, nbytes: 0n, flags: 1 });
  assert.equal(child.io("fd_read", 2), 0);
  assert.equal(child.view.getUint32(16, true), 0);
  child.wasi.descriptors.close(77);
  assert.equal(child.io("fd_read", 77), 8);
});

test("terminal targets share newline policy, cancellation, revocation and backpressure", () => {
  const bridge = new SharedBridge();
  const admission = createTerminalAdmission();
  const targets = [0, 1, 2] as const;
  const streams = targets.map((target) =>
    createBridgeTerminal(bridge.buffer, target, undefined, admission),
  );
  bridge.send(Uint8Array.of(13, 10));
  const raw = new Uint8Array(2);
  assert.equal(streams[2].tryRead!([raw]), 2);
  assert.deepEqual(raw, Uint8Array.of(13, 10));
  Atomics.store(bridge.state, control.phase, 2);
  bridge.send(Uint8Array.of(13));
  const byte = new Uint8Array(1);
  assert.equal(streams[2].tryRead!([byte]), 1);
  assert.equal(byte[0], 10);
  bridge.send(Uint8Array.of(10));
  assert.equal(streams[1].tryRead!([byte]), -6);
  bridge.send(Uint8Array.of(0, 255));
  assert.equal(streams[0].tryRead!([byte]), 1);
  assert.equal(byte[0], 0);
  assert.equal(streams[2].tryRead!([byte]), 1);
  assert.equal(byte[0], 255);
  assert.equal(streams[2].tryWrite!([new Uint8Array(OUTPUT_CAPACITY)]), OUTPUT_CAPACITY);
  assert.equal(streams[2].tryWrite!([byte]), -6);
  assert.equal(streams[2].readiness().writable, false);
  assert.equal(streams[2].readiness().nbytes, 0);
  bridge.drain(OUTPUT_CAPACITY);
  bridge.interrupt();
  bridge.send(Uint8Array.of(7));
  assert.equal(streams[2].tryRead!([byte]), -6);
  assert.equal(streams[2].read([byte]), -27);
  assert.equal(streams[2].readiness().readable, false);
  bridge.resumeInput();
  assert.equal(streams[2].tryRead!([byte]), 1);
  revokeTerminal(admission);
  for (const stream of streams) {
    assert.equal(stream.tryRead!([byte]), -29);
    assert.deepEqual(stream.readiness(), {
      readable: false,
      writable: false,
      hangup: true,
      nbytes: 0,
    });
  }
  assert.equal(bridge.closed(), false);
});

for (const stop of ["input", "cancel", "close", "revoke", "inactive"] as const) {
  test(
    `blocked guest fd_read on inherited terminal fd2 wakes on ${stop}`,
    { timeout: 5000 },
    async (context) => {
      const bridge = new SharedBridge();
      const admission = createTerminalAdmission();
      attachTerminal(admission, bridge.buffer);
      const active = new SharedArrayBuffer(4);
      const compiled = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
          import { parentPort, workerData } from 'node:worker_threads';
          import { terminalGuest } from './tests/helpers/terminal-wasi-guest';
          import { createBridgeTerminal } from './src/runtime/runtime-terminals';
          const { buffer, admission, active } = workerData;
          let entered = false;
          const checkActive = () => {
            if (Atomics.load(new Int32Array(active), 0)) throw new Error('inactive terminal');
            if (!entered) { entered = true; parentPort.postMessage('entered'); }
          };
          const endpoint = createBridgeTerminal(buffer, 2, checkActive, admission);
          const guest = terminalGuest({ 2: endpoint });
          try {
            const errno = guest.io('fd_read', 2, 1);
            parentPort.postMessage({ errno, count: guest.view.getUint32(16, true), byte: guest.bytes[256] });
          } catch (error) {
            parentPort.postMessage({ error: error.message });
          } finally {
            guest.wasi.descriptors.dispose();
          }
        `,
        },
        bundle: true,
        platform: "neutral",
        conditions: ["browser"],
        mainFields: ["browser", "module", "main"],
        external: ["node:*"],
        format: "cjs",
        write: false,
      });
      const worker = new Worker(compiled.outputFiles[0]!.text, {
        eval: true,
        workerData: { buffer: bridge.buffer, admission, active },
      });
      context.after(async () => {
        await worker.terminate();
      });
      assert.deepEqual(await once(worker, "message"), ["entered"]);
      const reply = once(worker, "message");
      if (stop === "input") bridge.send(Uint8Array.of(255));
      if (stop === "cancel") bridge.interrupt();
      if (stop === "close") bridge.close();
      if (stop === "revoke") revokeTerminal(admission);
      if (stop === "inactive") {
        Atomics.store(new Int32Array(active), 0, 1);
        bridge.signal();
      }
      const [result] = await reply;
      const errno = stop === "cancel" ? 27 : stop === "revoke" || stop === "inactive" ? 29 : 0;
      assert.deepEqual(result, {
        errno,
        count: stop === "input" ? 1 : 0,
        byte: stop === "input" ? 255 : 0,
      });
    },
  );
}

test("all terminal targets check liveness and fail closed after a bridge crash", () => {
  const bridge = new SharedBridge();
  const targets = [0, 1, 2] as const;
  for (const target of targets) {
    const inactive = createBridgeTerminal(bridge.buffer, target, () => {
      throw new Error("inactive");
    });
    assert.throws(() => inactive.tryRead!([new Uint8Array(1)]), /inactive/);
    assert.throws(() => inactive.readiness(), /inactive/);
  }
  Atomics.store(bridge.state, control.phase, 4);
  bridge.close();
  for (const target of targets) {
    const stream = createBridgeTerminal(bridge.buffer, target);
    assert.equal(stream.tryRead!([new Uint8Array(1)]), -29);
    assert.deepEqual(stream.readiness(), {
      readable: false,
      writable: false,
      hangup: true,
      nbytes: 0,
    });
  }
});
