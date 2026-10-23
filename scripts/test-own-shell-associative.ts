import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const fixture: {
  bash: string;
  env: Record<string, string>;
  cases: { id: string; script: string; status: number; stdoutHex: string; stderrHex?: string }[];
} = JSON.parse(readFileSync(new URL("fixtures/shell-associative.json", import.meta.url), "utf8"));
assert.equal(fixture.bash, "5.3.15(1)-release");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  modulePath: resolve(process.env.ASSOCIATIVE_WASM ?? resolve(directory, "shell-runtime.wasm")),
  fixtureDirectory: process.env.ASSOCIATIVE_FIXTURES ?? directory,
  tmp: "/tmp/spec",
  env: fixture.env,
});
for (const item of fixture.cases)
  test(`associative arrays ${item.id}`, async () => {
    const actual = await runner(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status);
    assert.equal(actual.stdout.toString("hex"), item.stdoutHex);
    if (item.stderrHex !== undefined) assert.equal(actual.stderr.toString("hex"), item.stderrHex);
  });
