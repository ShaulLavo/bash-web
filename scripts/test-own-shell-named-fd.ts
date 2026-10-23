import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import fixture from "./fixtures/shell-named-fd.json" with { type: "json" };
import { createWaffleRunner } from "./waffle-compat.ts";
import { liveNodeWorkers } from "./node-worker-host.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: fixture.env.TMP,
  env: fixture.env,
});
for (const { id, script, status, stdout, stderr } of fixture.cases)
  test(`real Waffle named descriptors: ${id}`, async () => {
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from(stdout, "base64"));
    assert.deepEqual(actual.stderr, Buffer.from(stderr, "base64"));
    assert.equal(liveNodeWorkers(), 0);
  });
