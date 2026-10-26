import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const utilities = ["cat", "grep", "head", "ls", "mkdir", "rg", "sed", "seq", "tail", "wc"] as const;

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

test("wc packages the surveyed upstream source, scalar build and license", () => {
  const revision = "07763857f6b9a547742a994b58aef0ccd036198b";
  const manifest = readFileSync(resolve(root, "shell/wc/Cargo.toml"), "utf8");
  for (const name of ["uu_wc", "uucore"]) {
    assert.match(manifest, new RegExp(`${name} = \\{ git = "https://github.com/uutils/coreutils"`));
    assert.match(manifest, new RegExp(`rev = "${revision}"`));
  }
  const entry = readFileSync(resolve(root, "shell/wc/src/bin/wc.rs"), "utf8");
  assert.match(entry, /uucore::bin!\(uu_wc\)/);
  const build = readFileSync(resolve(root, "scripts/build-wc.ts"), "utf8");
  assert.match(build, /target-feature=-simd128/);
  const bytecount = readFileSync(resolve(root, "shell/wc/vendor/bytecount/src/lib.rs"), "utf8");
  assert.match(bytecount, /all\(target_arch = "wasm32", target_feature = "simd128"\)/);
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.match(notices, /## shell-wc 0\.0\.1 \/ LICENSE\.uutils-coreutils/);
});
