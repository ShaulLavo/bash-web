import assert from "node:assert/strict";
import test from "node:test";
import { dependencyInputs, nativeInputs } from "./ci-inputs.ts";

const waffle = "git+https://github.com/ShaulLavo/waffle.git#abc";
const entry = (path: string, id = "abc") => `100644 blob ${id}\t${path}`;

test("native inputs exclude browser, prose and root package version changes", () => {
  assert.equal(
    nativeInputs([entry("src/shell.ts"), entry("docs/development.md")], waffle),
    nativeInputs([], waffle),
  );
});

for (const path of [
  "shell/engine/src/lib.rs",
  "shell/parser/LICENSE",
  "shell/engine/LICENSE",
  "docs/evidence/licenses/oils-LICENSE.txt",
  "docs/evidence/licenses/brush-MIT.txt",
  "docs/evidence/licenses/NOTICE-extra.txt",
  "shell/engine/tests/fixtures/example.md",
  "sources.lock.json",
  "shell/parser/Cargo.toml",
  "shell/Cargo.lock",
  "shell/compat-fixtures/src/lib.rs",
  "tests/guest/src/bin/test-spin.rs",
  "tests/guest/Cargo.lock",
  ".cargo/config.toml",
  "rust-toolchain.toml",
  ".github/workflows/ci.yml",
  ".github/actions/wasi-sdk/action.yml",
  "scripts/wasi-build.ts",
  "scripts/build-shell.ts",
  "scripts/build-test-guest.mjs",
  "scripts/test-shell-wasi.ts",
  "scripts/check-rust-quality.mjs",
  "scripts/ci-inputs.ts",
  "scripts/test-wasi-build.ts",
  "scripts/verify-wasi-guests.ts",
  "scripts/test-verify-wasi-guests.ts",
  "shell/engine/tests/fixtures/example.json",
  "scripts/prepare-wasi-tests.ts",
  "scripts/test-prepare-wasi-tests.ts",
]) {
  test(`${path} invalidates native checks and binaries`, () => {
    assert.notEqual(
      nativeInputs([entry(path)], waffle),
      nativeInputs([entry(path, "def")], waffle),
    );
  });
}

test("the shared libc dependency invalidates native checks", () => {
  assert.notEqual(nativeInputs([], waffle), nativeInputs([], waffle + "def"));
});

test("dependency cache ignores only root package patch bumps", () => {
  const lock = {
    version: "0.0.1",
    packages: { "": { version: "0.0.1" }, dependency: { version: "1.2.3" } },
  };
  const first = dependencyInputs(JSON.stringify(lock));
  lock.version = "0.0.2";
  lock.packages[""].version = "0.0.2";
  assert.equal(first, dependencyInputs(JSON.stringify(lock)));
  lock.packages.dependency.version = "1.2.4";
  assert.notEqual(first, dependencyInputs(JSON.stringify(lock)));
});

test("native build commands invalidate binaries", () => {
  assert.notEqual(
    nativeInputs([], waffle, { "build:shell": "first" }),
    nativeInputs([], waffle, { "build:shell": "second" }),
  );
});

for (const path of [
  "scripts/ci-artifacts.ts",
  "scripts/test-ci-artifacts.ts",
  "scripts/test-ci-workflow.ts",
  "scripts/waffle-compat.ts",
  "scripts/waffle-node-api.ts",
  "scripts/check-shell-capabilities.ts",
  "scripts/build-compat-control.ts",
  "scripts/test-build-compat-control.ts",
  "scripts/build-node-harness.ts",
  "scripts/test-shell-wasi.ts",
  "scripts/diagnose-compat.ts",
]) {
  test(`${path} is included in the complete build and gate input closure`, () => {
    assert.notEqual(
      nativeInputs([entry(path)], waffle),
      nativeInputs([entry(path, "def")], waffle),
    );
  });
}

test("any dependency lock change invalidates the native artifact recipe", () => {
  assert.notEqual(
    nativeInputs([], waffle, {}, "first-lock"),
    nativeInputs([], waffle, {}, "second-lock"),
  );
});
