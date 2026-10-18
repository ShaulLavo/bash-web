// Inspect final guest code, not just imports or compiler command lines. The stock
// scanner imports fdstat too, but never calls it from preopen discovery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  integer() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.offset++];
      assert.notEqual(byte, undefined, "truncated Wasm integer");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
      assert.ok(shift < 35, "oversized Wasm integer");
    }
  }
  slice(length: number) {
    const start = this.offset;
    this.offset += length;
    assert.ok(this.offset <= this.bytes.length, "truncated Wasm section");
    return this.bytes.subarray(start, this.offset);
  }
}

function functionNames(module: WebAssembly.Module) {
  const names = new Map<string, number>();
  for (const section of WebAssembly.Module.customSections(module, "name")) {
    const reader = new Reader(new Uint8Array(section));
    while (reader.offset < reader.bytes.length) {
      const kind = reader.integer();
      const data = new Reader(reader.slice(reader.integer()));
      if (kind !== 1) continue;
      const count = data.integer();
      for (let index = 0; index < count; index++) {
        const functionIndex = data.integer();
        names.set(new TextDecoder().decode(data.slice(data.integer())), functionIndex);
      }
    }
  }
  return names;
}

export function verifyWasiGuest(
  path: string,
  sdk = process.env.WASI_SDK_PATH ?? "/work/cache/wasi-sdk-34.0-x86_64-linux",
) {
  const bytes = readFileSync(path);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  // Guests own their only memory. The defined-memory section below cannot
  // account for additional host-provided memories, even when it is capped.
  assert.ok(
    !imports.some((entry) => entry.kind === "memory"),
    `${path}: guest memory must not be imported`,
  );
  const names = functionNames(module);
  const scanner = "__wasilibc_populate_preopens";
  const hasScanner = names.has(scanner);
  if (hasScanner) {
    const disassembly = execFileSync(
      resolve(sdk, "bin/llvm-objdump"),
      [`--disassemble-symbols=${scanner}`, path],
      { encoding: "utf8" },
    );
    for (const syscall of ["__wasi_fd_prestat_get", "__wasi_fd_fdstat_get"]) {
      const index = names.get(syscall);
      assert.notEqual(index, undefined, `${path}: missing ${syscall}`);
      assert.match(
        disassembly,
        new RegExp(`\\bcall\\s+${index}(?:\\s|$)`),
        `${path}: libc scanner does not call ${syscall}; stock libc may have been linked`,
      );
    }
  } else {
    // The CLI uses its fixture filesystem; the browser shell has its original
    // Rust WASI adapter. Neither needs libc path I/O. Permit deadstripping only
    // when path/prestat imports are absent or provably belong to that adapter,
    // never when a stripped libc scanner could be hiding behind those imports.
    const functions = imports.filter((entry) => entry.kind === "function");
    for (let index = 0; index < functions.length; index++) {
      const entry = functions[index];
      if (entry.module !== "wasi_snapshot_preview1" || !/^(fd_prestat_|path_)/.test(entry.name))
        continue;
      assert.equal(
        names.get(`shell_engine::runtime::wasi::${entry.name}`),
        index,
        `${path}: filesystem imports remain but libc scanner is missing`,
      );
    }
  }
  const reader = new Reader(bytes);
  reader.slice(8); // Magic/version were already validated by WebAssembly.Module.
  let cappedMemory = false;
  while (reader.offset < bytes.length) {
    const kind = reader.integer();
    const section = new Reader(reader.slice(reader.integer()));
    if (kind !== 5) continue;
    assert.equal(section.integer(), 1, `${path}: expected one guest memory`);
    const flags = section.integer();
    assert.equal(flags, 1, `${path}: guest memory must declare an unshared maximum`);
    section.integer(); // Minimum pages.
    assert.equal(section.integer(), 4096, `${path}: guest memory cap changed`);
    cappedMemory = true;
  }
  assert.ok(cappedMemory, `${path}: no capped guest memory found`);
  console.log(
    `Verified ${hasScanner ? "patched preopen scanner" : "no retained libc filesystem code"} and 256 MiB cap: ${path}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length > 2, "Pass final Wasm guest paths to inspect");
  for (const path of process.argv.slice(2)) verifyWasiGuest(resolve(path));
}
