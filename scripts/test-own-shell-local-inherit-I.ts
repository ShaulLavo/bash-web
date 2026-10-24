import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { resolve } from "node:path";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { assertReaderOutput } from "./recorded-bash.ts";
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
    assertReaderOutput(actual, entry.bash);
  });
}
// These are authored ownership controls, not additional Bash oracle recordings.
const ownershipControls = [
  {
    name: "caller scalar is copied and restored",
    code: "v=global; inner() { local -I v+=tail; printf '%s\\n' \"$v\"; }; outer() { local v=caller; inner; printf '%s\\n' \"$v\"; }; outer; printf '%s\\n' \"$v\"",
    stdout: "callertail\ncaller\nglobal\n",
  },
  {
    name: "function prefix and current unset local have different owners",
    code: "v=global; inner() { local -I v; printf '[%s]\\n' \"$v\"; }; outer() { local v; inner; unset v; local -I v; inner; }; v=prefix outer; printf '[%s]\\n' \"$v\"",
    stdout: "[prefix]\n[]\n[global]\n",
  },
  {
    name: "case and export flags return to the caller",
    code: "declare -u v=outer; f() { local -Ix v; v=mixed; declare -p v; }; f; declare -p v",
    stdout: 'declare -xu v="MIXED"\ndeclare -u v="OUTER"\n',
  },
  {
    name: "ordinary operand failure aggregates and later operands still run",
    code: "f() { local -I 'bad-name=x' v=ok; printf '%s:%s\\n' \"$?\" \"$v\"; }; f; printf '%s\\n' \"${v-unset}\"",
    stdout: "1:ok\nunset\n",
  },
];
for (const control of ownershipControls) {
  test(`local inheritance ownership: ${control.name}`, async () => {
    const actual = await run(control.code);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.equal(actual.status, 0);
    assert.equal(actual.stdout.toString(), control.stdout);
  });
}
after(() => assert.equal(liveNodeWorkers(), 0));
