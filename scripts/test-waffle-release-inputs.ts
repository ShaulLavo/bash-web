import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { waffleBuildFixture } from "../tests/helpers/waffle-build-inputs.ts";
import { prepareWaffleBuildInputs } from "./waffle-release-inputs.ts";

function fixture(context: TestContext) {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "waffle-input-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = waffleBuildFixture(root, "exact builder", "exact patch");
  const staged = resolve(root, ".build/waffle-inputs", selected.revision, "packages/waffle");
  rmSync(staged, { recursive: true });
  const downloads = new Map([
    ["scripts/build-wasi-libc.sh", "exact builder"],
    ["patches/wasi-libc/preopen-scan.patch", "exact patch"],
  ]);
  const requests: string[] = [];
  const download = (url: string) => {
    requests.push(url);
    const prefix = `https://raw.githubusercontent.com/ShaulLavo/waffle/${selected.revision}/packages/waffle/`;
    assert.ok(url.startsWith(prefix));
    const bytes = downloads.get(url.slice(prefix.length));
    assert.ok(bytes);
    return new TextEncoder().encode(bytes);
  };
  return { root, staged, selected, requests, download, downloads };
}

test("exact-source builder and patch stage together, reuse verified bytes and leave the runtime unchanged", (context) => {
  const f = fixture(context);
  const first = prepareWaffleBuildInputs(f.root, f.download);
  assert.equal(readFileSync(first.builder, "utf8"), "exact builder");
  assert.equal(readFileSync(first.patch, "utf8"), "exact patch");
  assert.equal(first.revision, f.selected.revision);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(prepareWaffleBuildInputs(f.root, f.download), first);
  assert.equal(f.requests.length, 2);
  assert.equal(existsSync(resolve(f.root, "node_modules/waffle/patches")), false);
  writeFileSync(first.patch, "corrupt cached source");
  assert.throws(() => prepareWaffleBuildInputs(f.root, f.download), /checksum mismatch/);
  assert.equal(readFileSync(first.patch, "utf8"), "corrupt cached source");
});

test("wrong downloaded bytes cannot satisfy the selected source recipe", (context) => {
  const f = fixture(context);
  f.downloads.set("patches/wasi-libc/preopen-scan.patch", "wrong bytes");
  assert.throws(() => prepareWaffleBuildInputs(f.root, f.download), /checksum mismatch/);
  assert.equal(existsSync(resolve(f.staged, "patches/wasi-libc/preopen-scan.patch")), false);
});

test("an unselected runtime pin or installed builder fails before source acquisition", (context) => {
  const f = fixture(context);
  writeFileSync(
    resolve(f.root, "package.json"),
    JSON.stringify({ devDependencies: { waffle: "unselected" } }),
  );
  assert.throws(() => prepareWaffleBuildInputs(f.root, f.download), /release pin mismatch/);
  assert.equal(f.requests.length, 0);
  waffleBuildFixture(f.root, "exact builder", "exact patch");
  writeFileSync(
    resolve(f.root, "node_modules/waffle/scripts/build-wasi-libc.sh"),
    "unselected builder",
  );
  assert.throws(() => prepareWaffleBuildInputs(f.root, f.download), /builder differs/);
  assert.equal(f.requests.length, 0);
});
