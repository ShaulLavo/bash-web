import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

type Observation = { id: string; script: string; status: number; stdout: string };
const fixture: {
  schema: number;
  bash: string;
  environment: Record<string, string>;
  cases: Observation[];
} = JSON.parse(
  readFileSync(new URL("fixtures/shell-nameref-attributes.json", import.meta.url), "utf8"),
);
assert.equal(fixture.schema, 1);
assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
assert.equal(process.version, "v26.7.0");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const native = process.env.NAMEREF_ATTRIBUTES_NATIVE;
const run = native
  ? async (script: string) =>
      spawnSync(native, ["-c", script], {
        env: fixture.environment,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      })
  : await createWaffleRunner({
      modulePath: resolve(directory, "shell-runtime.wasm"),
      fixtureDirectory: directory,
      tmp: "/tmp/spec",
      env: fixture.environment,
    });
for (const item of fixture.cases)
  test(`nameref attributes: ${item.id}`, async () => {
    const actual = await run(item.script);
    if ("error" in actual) assert.equal(actual.error, undefined);
    if ("crash" in actual) assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from(item.stdout, "base64"));
  });
after(() => assert.equal(liveNodeWorkers(), 0));
