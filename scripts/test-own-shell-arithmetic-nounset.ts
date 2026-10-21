import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

// Recorded GNU Bash 5.3.15 controls, not the CI host's installed Bash version.
const fixture: {
  schema: number;
  bash: string;
  environment: { PATH: string; HOME: string; TMP: string; LC_ALL: string };
  cases: { script: string; status: number; stdout: string; stderr: string }[];
} = JSON.parse(
  readFileSync(new URL("fixtures/shell-arithmetic-nounset.json", import.meta.url), "utf8"),
);
assert.equal(fixture.schema, 1);
assert.equal(fixture.bash, "5.3.15(1)-release");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  env: fixture.environment,
  tmp: fixture.environment.TMP,
  utilityDirectory: directory,
  fixtureDirectory: directory,
  modulePath: resolve(directory, "shell-runtime.wasm"),
});

for (const expected of fixture.cases)
  test(`production Waffle scalar arithmetic nounset: ${expected.script}`, async () => {
    const actual = await runner(expected.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, Buffer.from(expected.stdout));
    assert.deepEqual(actual.stderr, Buffer.from(expected.stderr));
  });
