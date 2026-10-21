import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

for (const args of [[], ["origin/main"], ["ced6049"]]) {
  test(`compatibility control requires an explicit immutable commit: ${args.join(" ")}`, () => {
    const result = spawnSync(process.execPath, ["scripts/build-compat-control.ts"].concat(args), {
      cwd: root,
      env: { ...process.env, PATH: "/nonexistent" },
      encoding: "utf8",
      timeout: 2000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass an immutable full commit SHA/);
    assert.doesNotMatch(result.stderr, /spawnSync git/);
  });
}
