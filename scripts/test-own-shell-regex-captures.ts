import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

type Recorded = {
  name: string;
  script: string;
  status: number;
  stdoutBase64: string;
  stderrBase64: string;
};
const fixture: { bash: string; cases: Recorded[] } = JSON.parse(
  readFileSync(new URL("fixtures/shell-regex-captures.json", import.meta.url), "utf8"),
);
assert.equal(fixture.bash, "5.3.15(1)-release");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C" },
  tmp: "/tmp/spec",
  utilityDirectory: directory,
  fixtureDirectory: directory,
  modulePath: resolve(directory, "shell-runtime.wasm"),
});
const observations: object[] = [];
after(() => {
  if (process.env.BASH_REGEX_CAPTURES_OUT)
    writeFileSync(process.env.BASH_REGEX_CAPTURES_OUT, JSON.stringify(observations, null, 2) + "\n");
});
for (const expected of fixture.cases)
  test(`production Waffle regex captures: ${expected.name}`, async () => {
    const actual = await runner(expected.script);
    observations.push({
      name: expected.name,
      status: actual.status,
      stdoutBase64: actual.stdout.toString("base64"),
      stderrBase64: actual.stderr.toString("base64"),
      crash: actual.crash,
    });
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, Buffer.from(expected.stdoutBase64, "base64"));
  });
