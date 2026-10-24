import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { resolve } from "node:path";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

type OracleCase = {
  id: string;
  code: string;
  bash: { status: number; stdout: string; stderr: string };
};
const oracle: { cases: OracleCase[]; environment: { env: Record<string, string> } } = JSON.parse(
  readFileSync(new URL("../docs/evidence/own-shell-oracle.json", import.meta.url), "utf8"),
);
const selected = [6, 7, 8, 10, 11, 12];
const neighbors = [1, 4, 5, 9];
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
assert.equal(process.version, "v26.12.1");
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  tmp: "/tmp/spec",
  env: oracle.environment.env,
});
for (const line of selected.concat(neighbors)) {
  const id = `brush-suite:variables:${line}`;
  const entry = oracle.cases.find((item) => item.id === id);
  assert.ok(entry);
  test(`local inheritance frozen ${id}`, async () => {
    const actual = await run(entry.code);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.equal(actual.status, entry.bash.status);
    assert.deepEqual(actual.stdout, Buffer.from(entry.bash.stdout, "base64"));
  });
}
after(() => assert.equal(liveNodeWorkers(), 0));
