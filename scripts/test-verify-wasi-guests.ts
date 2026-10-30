import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { verifyStrippedWasiGuest } from "./verify-family-guests.ts";
import { stripNames } from "./capture-family-symbols.ts";

const integer = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const text = (value: string) =>
  integer(value.length).concat(Array.from(new TextEncoder().encode(value)));
const section = (kind: number, body: number[]) => [kind].concat(integer(body.length), body);

// Original minimal modules for the verifier only; production artifacts are also
// inspected by every build entrypoint. The disassembler is a controlled stand-in.
function moduleBytes(maximum: number, withNames = true, adapter = false) {
  const imports = [2].concat(
    ...["fd_prestat_get", "fd_fdstat_get"].map((name) =>
      text("wasi_snapshot_preview1").concat(text(name), [0, 0]),
    ),
  );
  const names = adapter
    ? [2].concat(
        [0],
        text("shell_engine::runtime::wasi::fd_prestat_get"),
        [1],
        text("shell_engine::runtime::wasi::fd_fdstat_get"),
      )
    : [3].concat(
        [0],
        text("__wasi_fd_prestat_get"),
        [1],
        text("__wasi_fd_fdstat_get"),
        [2],
        text("__wasilibc_populate_preopens"),
      );
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [1, 0x60, 0, 0]),
      section(2, imports),
      section(3, [1, 0]),
      section(5, [1, 1, 1].concat(integer(maximum))),
      section(10, [1, 6, 0, 0x10, 0, 0x10, 1, 0x0b]),
      withNames ? section(0, text("name").concat(section(1, names))) : [],
    ),
  );
}

function fixture(
  run: (path: string, sdk: string, setDisassembly: (text: string) => void) => void,
  maximum = 4096,
) {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "wasi-verifier-test-"));
  try {
    mkdirSync(resolve(root, "bin"));
    const path = resolve(root, "guest.wasm");
    writeFileSync(path, moduleBytes(maximum));
    const tool = resolve(root, "bin/llvm-objdump");
    const setDisassembly = (text: string) => {
      writeFileSync(tool, `#!/bin/bash\nprintf '%s\\n' '${text}'\n`);
      chmodSync(tool, 0o755);
    };
    setDisassembly("  call 0\n  call 1\n");
    run(path, root, setDisassembly);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("verifier accepts scanner code containing both probes and capped memory", () => {
  fixture((path, sdk) => verifyWasiGuest(path, sdk));
});

test("an fdstat import alone does not prove the scanner was patched", () => {
  fixture((path, sdk, setDisassembly) => {
    setDisassembly("  call 0\n  call 11\n");
    assert.throws(() => verifyWasiGuest(path, sdk), /scanner does not call __wasi_fd_fdstat_get/);
  });
});

test("verifier rejects final guest memory cap drift", () => {
  fixture((path, sdk) => {
    assert.throws(() => verifyWasiGuest(path, sdk), /guest memory cap changed/);
  }, 65536);
});

for (const [description, limits] of [
  ["uncapped", [0, 1]],
  ["512 MiB", [1, 1].concat(integer(8192))],
] as const) {
  test(`verifier rejects an additional ${description} imported memory`, () => {
    fixture((path, sdk) => {
      const bytes = new Uint8Array(
        [0, 97, 115, 109, 1, 0, 0, 0].concat(
          section(2, [1].concat(text("env"), text("extraMemory"), [2], limits)),
          section(5, [1, 1, 1].concat(integer(4096))),
        ),
      );
      assert.ok(WebAssembly.validate(bytes), "control must be a valid Wasm module");
      writeFileSync(path, bytes);
      assert.throws(() => verifyWasiGuest(path, sdk), /guest memory must not be imported/);
    });
  });
}

test("deadstripped libc is accepted only when no filesystem imports remain", () => {
  fixture((path, sdk) => {
    writeFileSync(
      path,
      new Uint8Array(
        [0, 97, 115, 109, 1, 0, 0, 0].concat(section(5, [1, 1, 1].concat(integer(4096)))),
      ),
    );
    verifyWasiGuest(path, sdk);
    writeFileSync(path, moduleBytes(4096, false));
    assert.throws(
      () => verifyWasiGuest(path, sdk),
      /filesystem imports remain but libc scanner is missing/,
    );
  });
});

test("direct Rust adapter imports prove scanner omission without hiding libc", () => {
  fixture((path, sdk) => {
    writeFileSync(path, moduleBytes(4096, true, true));
    verifyWasiGuest(path, sdk);
  });
});

test("capture removes only complete name sections and preserves every other encoded byte", () => {
  const extra = Buffer.from(section(0, text("names").concat([1, 2, 3])));
  const named = Buffer.concat([moduleBytes(4096), extra]);
  const stripped = Buffer.concat([moduleBytes(4096, false), extra]);
  assert.deepEqual(stripNames(named).bytes, stripped);
});

function strippedProof(bytes: Uint8Array) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    nameOffset: bytes.byteLength,
    symbols: {
      __wasi_fd_prestat_get: 0,
      __wasi_fd_fdstat_get: 1,
      __wasilibc_populate_preopens: 2,
    },
  };
}

test("release symbol proof restores inspection without changing the shipped guest", () => {
  fixture((path, sdk) => {
    const bytes = moduleBytes(4096, false);
    writeFileSync(path, bytes);
    verifyStrippedWasiGuest(path, strippedProof(bytes), sdk);
    assert.deepEqual(readFileSync(path), Buffer.from(bytes));
  });
});

test("a symbol proof cannot admit different guest bytes", () => {
  fixture((path, sdk) => {
    const bytes = moduleBytes(4096, false);
    writeFileSync(path, moduleBytes(65536, false));
    assert.throws(
      () => verifyStrippedWasiGuest(path, strippedProof(bytes), sdk),
      /differs from its symbol proof/,
    );
  });
});

test("restored release symbols still require the actual scanner fdstat call", () => {
  fixture((path, sdk, setDisassembly) => {
    const bytes = moduleBytes(4096, false);
    writeFileSync(path, bytes);
    setDisassembly("  call 0\n  call 11\n");
    assert.throws(
      () => verifyStrippedWasiGuest(path, strippedProof(bytes), sdk),
      /scanner does not call __wasi_fd_fdstat_get/,
    );
  });
});

test("restored release symbols still require the original guest memory cap", () => {
  fixture((path, sdk) => {
    const bytes = moduleBytes(65536, false);
    writeFileSync(path, bytes);
    assert.throws(
      () => verifyStrippedWasiGuest(path, strippedProof(bytes), sdk),
      /guest memory cap changed/,
    );
  });
});
