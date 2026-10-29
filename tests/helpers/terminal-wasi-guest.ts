import assert from "node:assert/strict";
import { Wasi, type Stream } from "waffle/core";
import { MemFS } from "waffle/fs/memory";

import { leb, name, section } from "./wasm-binary";

// Tiny original guest. Each exported four-i32 function calls its actual WASI import.
// No SDK, utility artifact, runtime instance, or guest fixture rebuild is needed.
export function terminalGuest(stdio?: Partial<Record<0 | 1 | 2, Stream>>) {
  const operations = ["fd_read", "fd_write", "poll_oneoff"];
  const imports = operations.flatMap((operation) =>
    name("wasi_snapshot_preview1").concat(name(operation), [0, 0]),
  );
  const exports = operations.flatMap((operation, index) => name(operation).concat([0, index + 3]));
  const bodies = operations.flatMap((_operation, index) => {
    const body = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x10, index, 0x0b];
    return leb(body.length).concat(body);
  });
  const module = new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
        section(2, [3].concat(imports)),
        section(3, [3, 0, 0, 0]),
        section(5, [1, 0, 1]),
        section(7, [4].concat(name("memory"), [2, 0], exports)),
        section(10, [3].concat(bodies)),
      ),
    ),
  );
  const fs = new MemFS();
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: {},
    stdio,
    sleep() {},
    stdout() {},
    stderr() {},
  });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const memory = instance.exports.memory;
  assert.ok(memory instanceof WebAssembly.Memory);
  wasi.bindMemory(memory);
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const call = (operation: string, a: number, b: number, c: number, d: number) => {
    const fn = instance.exports[operation];
    assert.equal(typeof fn, "function");
    if (typeof fn !== "function") throw new Error("missing guest export");
    return fn(a, b, c, d);
  };
  const io = (operation: "fd_read" | "fd_write", fd: number, length = 8) => {
    view.setUint32(0, 256, true);
    view.setUint32(4, length, true);
    return call(operation, fd, 0, 1, 16);
  };
  const poll = (fd: number, type = 1) => {
    bytes.fill(0, 32, 80);
    view.setUint8(40, type);
    view.setUint32(48, fd, true);
    assert.equal(call("poll_oneoff", 32, 96, 1, 128), 0);
    assert.equal(view.getUint32(128, true), 1);
    return {
      error: view.getUint16(104, true),
      nbytes: view.getBigUint64(112, true),
      flags: view.getUint16(120, true),
    };
  };
  return { wasi, fs, view, bytes, io, poll };
}
