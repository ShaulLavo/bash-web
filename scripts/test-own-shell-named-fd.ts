import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import named from "./fixtures/shell-named-fd.json" with { type: "json" };
import diagnostics from "./fixtures/shell-redirect-diagnostics.json" with { type: "json" };
import { createWaffleRunner } from "./waffle-compat.ts";
import { liveNodeWorkers } from "./node-worker-host.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const fixtures = [
  ["named descriptors", named],
  ["redirect diagnostics", diagnostics],
] as const;
for (const [, fixture] of fixtures) {
  assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
  assert.deepEqual(fixture.env, named.env);
}
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: named.env.TMP,
  env: named.env,
});
for (const [label, fixture] of fixtures)
  for (const { id, script, status, stdout, stderr } of fixture.cases)
    test(`real Waffle ${label}: ${id}`, async () => {
      const actual = await runner(script);
      assert.equal(actual.crash, undefined);
      assert.equal(actual.status, status, actual.stderr.toString());
      assert.deepEqual(actual.stdout, Buffer.from(stdout, "base64"));
      assert.deepEqual(actual.stderr, Buffer.from(stderr, "base64"));
      assert.equal(liveNodeWorkers(), 0);
    });
