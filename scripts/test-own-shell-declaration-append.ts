import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

type Observation = { name: string; code: string; status: number; stdout: string; stderr: string };
const fixture: {
  schema: number;
  bash: string;
  environment: Record<string, string>;
  cases: Observation[];
} = JSON.parse(readFileSync(new URL("fixtures/shell-declaration-append.json", import.meta.url), "utf8"));
assert.equal(fixture.schema, 1);
assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
assert.equal(process.version, "v26.7.0");
assert.equal(new Set(fixture.cases.map((item) => item.name)).size, fixture.cases.length);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  tmp: "/tmp/spec",
  env: fixture.environment,
});
for (const item of fixture.cases) {
  test(`declaration append: ${item.name}`, async () => {
    const actual = await run(item.code);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.equal(actual.status, item.status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from(item.stdout, "base64"));
  });
}
after(() => assert.equal(liveNodeWorkers(), 0));
