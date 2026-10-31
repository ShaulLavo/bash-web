import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

type Fixture = {
  bash: string;
  env: Record<string, string>;
  cases: { id: string; script: string; status: number; stdoutBase64: string }[];
};
const fixture: Fixture = JSON.parse(
  readFileSync(new URL("fixtures/shell-mapfile.json", import.meta.url), "utf8"),
);
assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  tmp: "/tmp/spec",
  env: fixture.env,
});
for (const item of fixture.cases)
  test(`production Waffle mapfile ${item.id}`, async () => {
    const actual = await run(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status, item.script);
    assert.deepEqual(actual.stdout, Buffer.from(item.stdoutBase64, "base64"), item.script);
  });
