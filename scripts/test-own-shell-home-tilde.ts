import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { assertReaderOutput } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

type Observation = { status: number; stdout: string; stderr: string };
type Case = { id: string; code: string; bash: Observation };
const fixture: { oracle: string; cases: Case[] } = JSON.parse(
  readFileSync(new URL("owned-fixtures/home-tilde-operands.json", import.meta.url), "utf8"),
);
assert.equal(fixture.oracle, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  tmp: "/tmp/spec",
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.utf8" },
});
after(() => assert.equal(liveNodeWorkers(), 0));
for (const entry of fixture.cases) {
  test(`production Waffle HOME tilde ${entry.id}`, async () => {
    const actual = await run(entry.code);
    assertReaderOutput(actual, entry.bash);
    assert.deepEqual(actual.stderr, Buffer.from(entry.bash.stderr, "base64"));
  });
}
