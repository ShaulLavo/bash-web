import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { wasiBuildConfiguration, wasiBuildEnvironment } from "./wasi-build.ts";

function fixture(run: (root: string, env: NodeJS.ProcessEnv) => void) {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "wasi-tooling-test-"));
  try {
    const put = (path: string, contents: string) => {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), contents);
    };
    put("sdk/VERSION", "34.0\nwasi-libc: 2e6fb9d8ee0c\n");
    put("node_modules/waffle/patches/wasi-libc/preopen-scan.patch", "fixture scanner patch");
    put(
      "node_modules/waffle/scripts/build-wasi-libc.sh",
      `#!/bin/bash
set -eu
[[ ! -e "$1" ]]
printf 'build\\n' >> "$PWD/builds"
mkdir -p "$1/lib/wasm32-wasip1"
printf 'fixture archive' > "$1/lib/wasm32-wasip1/libc.a"
`,
    );
    run(root, { ...process.env, WASI_SDK_PATH: resolve(root, "sdk") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("final Rust link uses patched WASI sysroot, clang target, no bundled libc, and memory cap", () => {
  fixture((root, env) => {
    env.RUSTFLAGS = "wrong libc flags";
    env.CARGO_ENCODED_RUSTFLAGS = "wrong encoded flags";
    env.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS = "wrong target flags";
    const config = wasiBuildConfiguration(root, env);
    const result = wasiBuildEnvironment(root, ".build/guest", env);
    assert.equal(result.CARGO_TARGET_DIR, resolve(root, ".build/guest"));
    assert.equal(result.CARGO_TARGET_WASM32_WASIP1_LINKER, resolve(root, "sdk/bin/clang"));
    assert.deepEqual(result.CARGO_ENCODED_RUSTFLAGS?.split("\x1f"), [
      "-C",
      "link-self-contained=no",
      "-C",
      "linker-flavor=gcc",
      "-C",
      `linker=${resolve(root, "sdk/bin/clang")}`,
      "-C",
      "link-arg=--target=wasm32-wasip1",
      "-C",
      `link-arg=--sysroot=${config.sysroot}`,
      "-C",
      "link-arg=-Wl,--max-memory=268435456",
    ]);
    assert.equal(result.RUSTFLAGS, undefined);
    assert.equal(result.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS, undefined);
    assert.equal(result.CC_wasm32_wasip1, result.CARGO_TARGET_WASM32_WASIP1_LINKER);
    assert.equal(result.CFLAGS_wasm32_wasip1, `--target=wasm32-wasip1 --sysroot=${config.sysroot}`);
    wasiBuildEnvironment(root, ".build/another-guest", env);
    assert.equal(readFileSync(resolve(root, "builds"), "utf8"), "build\n");
    assert.match(
      readFileSync(resolve(config.sysroot, "lib/wasm32-wasip1/libc.a"), "utf8"),
      /fixture archive/,
    );
  });
});

test("changing the pinned scanner recipe builds a fresh output instead of accepting stale libc", () => {
  fixture((root, env) => {
    const original = wasiBuildConfiguration(root, env);
    wasiBuildEnvironment(root, ".build/guest", env);
    writeFileSync(
      resolve(root, "node_modules/waffle/patches/wasi-libc/preopen-scan.patch"),
      "changed scanner",
    );
    const changed = wasiBuildConfiguration(root, env);
    assert.notEqual(original.sysroot, changed.sysroot);
    wasiBuildEnvironment(root, ".build/guest", env);
    assert.equal(readFileSync(resolve(root, "builds"), "utf8"), "build\nbuild\n");
  });
});

test("unreceipted output is neither reused nor deleted", () => {
  fixture((root, env) => {
    const config = wasiBuildConfiguration(root, env);
    mkdirSync(config.sysroot, { recursive: true });
    writeFileSync(resolve(config.sysroot, "owner-data"), "preserve");
    assert.throws(() => wasiBuildEnvironment(root, ".build/guest", env));
    assert.equal(readFileSync(resolve(config.sysroot, "owner-data"), "utf8"), "preserve");
  });
});

test("a stock or mismatched SDK is rejected before preparing any guest", () => {
  fixture((root, env) => {
    writeFileSync(resolve(root, "sdk/VERSION"), "33.0\nwasi-libc: other\n");
    assert.throws(() => wasiBuildConfiguration(root, env), /wasi-sdk 34.0/);
  });
});
