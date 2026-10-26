import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const utilities = ["cat", "grep", "mkdir", "seq", "sed"] as const;

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
