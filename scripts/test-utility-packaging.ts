import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import observations from "./owned-fixtures/sort-uniq.json" with { type: "json" };
import { loadSortUniqObservations } from "./sort-uniq-observations.ts";

const root = resolve(import.meta.dirname, "..");
const utilities = ["cat", "grep", "head", "mkdir", "seq", "sort", "uniq"] as const;

async function bundle(entry: string): Promise<string> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
    external: ["waffle", "waffle/*"],
    logLevel: "silent",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

test("package exports one core entry and one entry per utility", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const expected = Object.fromEntries(
    utilities.map((name) => [`./utilities/${name}`, `./src/utilities/${name}.ts`]),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.exports).filter(([key]) => key.startsWith("./utilities/")),
    ),
    expected,
  );
  assert.equal(manifest.exports["."], "./src/index.ts");
});

test("the core entry references no utility program", async () => {
  for (const entry of ["src/index.ts", "src/shell.ts"]) {
    const text = await bundle(entry);
    for (const name of utilities) assert.doesNotMatch(text, new RegExp(`${name}\\.wasm`), entry);
  }
});

test("each utility entry references only its own program", async () => {
  for (const name of utilities) {
    const text = await bundle(`src/utilities/${name}.ts`);
    assert.match(text, new RegExp(`dist/${name}\\.wasm`));
    for (const other of utilities.filter((value) => value !== name))
      assert.doesNotMatch(text, new RegExp(`${other}\\.wasm`), `${name} entry`);
    assert.match(text, new RegExp(`function install${name[0].toUpperCase()}${name.slice(1)}`));
  }
});

test("head packages the pinned upstream entry and its license notices", () => {
  const manifest = readFileSync(resolve(root, "shell/utilities/Cargo.toml"), "utf8");
  for (const name of ["uu_head", "uucore"])
    assert.match(manifest, new RegExp(`${name} = "=0\\.12\\.0"`));
  const entry = readFileSync(resolve(root, "shell/utilities/src/bin/head.rs"), "utf8");
  assert.match(entry, /uucore::bin!\(uu_head\)/);
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.match(notices, /## uu_head 0\.12\.0 \/ LICENSE/);
  assert.match(notices, /## uucore 0\.12\.0 \/ LICENSE/);
});

for (const name of ["sort", "uniq"]) {
  test(`${name} packages the exact upstream crate and license`, () => {
    const manifest = readFileSync(resolve(root, "shell/utilities/Cargo.toml"), "utf8");
    assert.ok(manifest.includes(`uu_${name} = "=0.12.0"`));
    const entry = readFileSync(resolve(root, `shell/utilities/src/bin/${name}.rs`), "utf8");
    assert.ok(entry.includes(`uucore::bin!(uu_${name})`));
    assert.ok(entry.includes(`cwd::initialize("${name}")`));
    const cwd = readFileSync(resolve(root, "shell/utilities/src/sort_uniq_cwd.rs"), "utf8");
    assert.match(cwd, /std::env::set_current_dir/);
    const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    assert.ok(notices.includes(`## uu_${name} 0.12.0 / LICENSE`));
  });
}

test("sort and uniq source receipts match the locked registry packages", () => {
  const receipt = JSON.parse(readFileSync(resolve(root, "docs/sort-uniq-source.json"), "utf8"));
  assert.equal(receipt.revision, "dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69");
  const lock = readFileSync(resolve(root, "shell/Cargo.lock"), "utf8");
  assert.deepEqual(
    receipt.packages.map((pkg: { name: string }) => pkg.name),
    ["uu_sort", "uu_uniq"],
  );
  for (const pkg of receipt.packages) {
    assert.ok(
      lock.includes(
        `name = "${pkg.name}"\nversion = "${pkg.version}"\nsource = "${pkg.registry}"\nchecksum = "${pkg.sha256}"`,
      ),
    );
  }
});

test("sort and uniq qualification cannot import a live host oracle", async () => {
  const result = await build({
    entryPoints: ["scripts/test-own-shell-sort-uniq.ts", "tests/sort-uniq.spec.ts"],
    outdir: "unused",
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    assert.equal(
      input.imports.some((entry) => /^(?:node:)?child_process$/.test(entry.path)),
      false,
      `${path} admits a host subprocess into sort/uniq qualification`,
    );
  }
});

test("sort and uniq reject missing, changed, and invalid frozen observations", () => {
  assert.equal(loadSortUniqObservations().length, 25);
  const missing = structuredClone(observations);
  missing.cases.pop();
  assert.throws(() => loadSortUniqObservations(missing), /must match every case/);
  const changed = structuredClone(observations);
  changed.cases[0].script += "; true";
  assert.throws(() => loadSortUniqObservations(changed), /must match every case/);
  const malformed = structuredClone(observations);
  malformed.cases[0].stdout = [256];
  assert.throws(() => loadSortUniqObservations(malformed));
  const wrongOracle = structuredClone(observations);
  wrongOracle.oracle.bash.version = "host bash";
  assert.throws(() => loadSortUniqObservations(wrongOracle));
});

test("native sort and uniq qualification runs candidates, not host GNU programs", () => {
  const source = readFileSync(resolve(root, "shell/utilities/tests/sort_uniq.rs"), "utf8");
  assert.match(source, /owned-fixtures\/sort-uniq\.json/);
  assert.doesNotMatch(source, /run\(name,|Command::new\("(?:bash|sort|uniq)"\)/);
});
