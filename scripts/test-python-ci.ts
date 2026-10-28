import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pythonCacheKey, pythonInputPaths } from "./python-ci.ts";

test("Python compilation is filtered by every guest input, SDK and toolchain, excluding unrelated changes", (context) => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "python-ci-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, data: string) => {
    const file = resolve(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  for (const path of pythonInputPaths) put(path, `fixture ${path}`);
  put("sdk/VERSION", "34.0\n");
  const key = () => pythonCacheKey(root, resolve(root, "sdk"), "cc and Python versions");
  const initial = key();
  put("src/browser/style.css", "unrelated feature change");
  put("package-lock.json", "unrelated dependency union");
  assert.equal(key(), initial);
  for (const path of pythonInputPaths.concat(["sdk/VERSION"])) {
    const before = readFileSync(resolve(root, path), "utf8");
    put(path, `${before} changed`);
    assert.notEqual(key(), initial, path);
    put(path, before);
  }
  assert.notEqual(pythonCacheKey(root, resolve(root, "sdk"), "new compiler"), initial);
});
