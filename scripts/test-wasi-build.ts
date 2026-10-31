import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  wasiBuildConfiguration,
  wasiBuildEnvironment,
  wasiCargoEnvironment,
  wasiSysrootCommand,
} from "./wasi-build.ts";
import { waffleBuildFixture, wasiBuildScripts } from "../tests/helpers/waffle-build-inputs.ts";

const builder = `#!/bin/bash
set -eu
[[ ! -e "$1" ]]
printf 'build\\n' >> "$PWD/builds"
mkdir -p "$1/lib/wasm32-wasip1"
printf 'fixture archive' > "$1/lib/wasm32-wasip1/libc.a"
`;

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
    waffleBuildFixture(root, builder, "fixture scanner patch");
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
    waffleBuildFixture(root, builder, "changed scanner");
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

function adapterGuest(adapter: string): Uint8Array {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imports = [1].concat(text("wasi_snapshot_preview1"), text("fd_prestat_get"), [0, 0]);
  const names = [1, 0].concat(text(`${adapter}::fd_prestat_get`));
  const bytes = Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [1, 0x60, 0, 0]),
      section(2, imports),
      section(5, [1, 1, 1, 128, 32]),
      section(0, text("name").concat(section(1, names))),
    ),
  );
  assert.ok(WebAssembly.validate(bytes));
  return bytes;
}

function runAdapterPolicy(binary: string, adapter: string) {
  fixture((root, env) => {
    const scripts = resolve(root, "scripts");
    mkdirSync(scripts);
    for (const file of wasiBuildScripts)
      copyFileSync(resolve(import.meta.dirname, file), resolve(scripts, file));
    const bin = resolve(root, "bin");
    mkdirSync(bin);
    const cargo = resolve(bin, "cargo");
    writeFileSync(
      cargo,
      '#!/bin/bash\nset -eu\nmkdir -p "$CARGO_TARGET_DIR/wasm32-wasip1/release"\ncp "$POLICY_GUEST" "$CARGO_TARGET_DIR/wasm32-wasip1/release/$POLICY_BINARY.wasm"\n',
    );
    chmodSync(cargo, 0o755);
    const guest = resolve(root, "guest.wasm");
    writeFileSync(guest, adapterGuest(adapter));
    const wrapper = pathToFileURL(resolve(scripts, "wasi-build.ts")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { buildWasiShell } from ${JSON.stringify(wrapper)}; buildWasiShell(["--bin", ${JSON.stringify(binary)}]);`,
      ],
      {
        cwd: root,
        env: {
          ...env,
          PATH: `${bin}:${env.PATH}`,
          CARGO_TARGET_DIR: resolve(root, ".build/target"),
          POLICY_GUEST: guest,
          POLICY_BINARY: binary,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    if (adapter === "waffle_program_support::runtime::wasi" || binary === "shell-engine") {
      assert.equal(result.status, 0, result.stderr);
      return;
    }
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /filesystem imports remain but libc scanner is missing/);
  });
}

for (const binary of ["shell-runtime", "argv-py", "printenv-py"]) {
  test(`${binary} build wrapper accepts only the canonical adapter identity`, () => {
    runAdapterPolicy(binary, "waffle_program_support::runtime::wasi");
    runAdapterPolicy(binary, "shell_engine::runtime::wasi");
  });
}

test("standalone shell build keeps its existing verifier policy", () => {
  runAdapterPolicy("shell-engine", "shell_engine::runtime::wasi");
});

test("Cargo environment calculation preserves caller values without preparing a sysroot", () => {
  fixture((root, env) => {
    env.CARGO_TARGET_DIR = "wrong-target";
    env.SHELL_BUILD_MARKER = "keep";
    const config = wasiBuildConfiguration(root, env);
    const result = wasiCargoEnvironment(root, ".build/isolated-guest", env);
    assert.equal(result.CARGO_TARGET_DIR, resolve(root, ".build/isolated-guest"));
    assert.equal(result.SHELL_BUILD_MARKER, "keep");
    assert.equal(env.CARGO_TARGET_DIR, "wrong-target");
    assert.equal(result.WASI_SDK_PATH, config.sdk);
    assert.throws(() => readFileSync(resolve(root, "builds")), { code: "ENOENT" });
    assert.throws(() => readFileSync(resolve(config.directory, "recipe.sha256")), {
      code: "ENOENT",
    });
  });
});

test("async-supervised preparation uses the supplied root and child environment", () => {
  fixture((root, env) => {
    const [command, args] = wasiSysrootCommand(root);
    execFileSync(command, args, { cwd: "/", env, stdio: "pipe" });
    const config = wasiBuildConfiguration(root, env);
    assert.equal(readFileSync(resolve(root, "builds"), "utf8"), "build\n");
    assert.equal(readFileSync(resolve(config.directory, "recipe.sha256"), "utf8"), config.identity);
  });
});
