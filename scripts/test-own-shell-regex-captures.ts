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
  diagnostic?: boolean;
};
function recording(path: string | URL): Recorded[] {
  const fixture: { bash: string; cases: Recorded[] } = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.bash, "5.3.15(1)-release");
  return fixture.cases;
}
const cases = process.env.BASH_REGEX_CAPTURES_FIXTURE
  ? recording(process.env.BASH_REGEX_CAPTURES_FIXTURE)
  : recording(new URL("fixtures/shell-regex-captures.json", import.meta.url)).concat(
      recording(new URL("fixtures/shell-regex-capture-choice.json", import.meta.url)),
    );
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
    writeFileSync(
      process.env.BASH_REGEX_CAPTURES_OUT,
      JSON.stringify(observations, null, 2) + "\n",
    );
});
for (const expected of cases)
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
    if (expected.diagnostic) {
      const recorded = Buffer.from(expected.stderrBase64, "base64").toString();
      assert.equal(actual.stderr.toString(), recorded.replaceAll(/: line \d+: /g, ": "));
    } else assert.deepEqual(actual.stderr, Buffer.from(expected.stderrBase64, "base64"));
  });

if (!process.env.BASH_REGEX_CAPTURES_FIXTURE)
  for (const expected of recording(
    new URL("fixtures/shell-regex-capture-unsupported.json", import.meta.url),
  ))
    test(`production Waffle rejects unsupported capture shape: ${expected.name}`, async () => {
      const actual = await runner(`BASH_REMATCH=sentinel; ${expected.script}`);
      assert.equal(actual.crash, undefined);
      assert.equal(actual.outputLimit, undefined);
      assert.equal(actual.status, 0);
      assert.equal(actual.stdout.toString(), "s=2 n=1<sentinel>");
      assert.equal(actual.stderr.length, 0);
    });
