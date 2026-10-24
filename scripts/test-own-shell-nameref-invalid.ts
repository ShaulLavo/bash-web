import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import fixture from "./fixtures/shell-nameref-invalid.json" with { type: "json" };
import { createWaffleRunner } from "./waffle-compat.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
assert.equal(fixture.bash, "5.3.15(1)-release");
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  tmp: fixture.env.TMP,
  env: fixture.env,
});
for (const { id, script, status, stdout } of fixture.cases)
  test(`production Waffle invalid nameref: ${id}`, async () => {
    const actual = await runner(script);
    console.log(
      JSON.stringify({
        id,
        status: actual.status,
        stdout: actual.stdout.toString("base64"),
        stderr: actual.stderr.toString("base64"),
        crash: actual.crash,
      }),
    );
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, status);
    assert.deepEqual(actual.stdout, Buffer.from(stdout, "base64"));
  });

for (const operand of [
  "ref=",
  "ref",
  "ref=array[",
  "ref=array]",
  "ref=PIPESTATUS",
  "PIPESTATUS=target",
])
  test(`production Waffle unsupported nameref stays status 2: ${operand}`, async () => {
    const actual = await runner(
      `target=kept; declare -n ${operand} later=target; echo "$?:\${ref+set}:\${later+set}:$target"`,
    );
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, 0);
    assert.deepEqual(actual.stdout, Buffer.from("2:::kept\n"));
  });
