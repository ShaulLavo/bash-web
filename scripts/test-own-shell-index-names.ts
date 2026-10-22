import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const fixture: {
  bash: string;
  env: Record<string, string>;
  cases: { id: string; script: string; status: number; stdoutHex: string }[];
} = JSON.parse(readFileSync(new URL("fixtures/shell-index-names.json", import.meta.url), "utf8"));
assert.equal(fixture.bash, "5.3.15(1)-release");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const native = process.env.INDEX_NAMES_NATIVE;
const runner = native
  ? async (script: string) =>
      spawnSync(native, ["-c", script], {
        env: fixture.env,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      })
  : await createWaffleRunner({
      modulePath: resolve(directory, "shell-runtime.wasm"),
      fixtureDirectory: directory,
      tmp: "/tmp/spec",
      env: fixture.env,
    });
for (const item of fixture.cases)
  test(`index names ${item.id}`, async () => {
    const actual = await runner(item.script);
    if ("error" in actual) assert.equal(actual.error, undefined);
    if ("crash" in actual) assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status);
    assert.equal(actual.stdout.toString("hex"), item.stdoutHex);
  });
