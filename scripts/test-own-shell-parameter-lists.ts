import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

const fixture: {
  bash: string;
  env: { PATH: string; HOME: string; TMP: string; LC_ALL: string; LANG: string };
  cases: { id: string; script: string; status: number; stdout: string; stderr: string }[];
} = JSON.parse(
  readFileSync(new URL("fixtures/shell-parameter-lists.json", import.meta.url), "utf8"),
);
assert.equal(fixture.bash, "5.3.15(1)-release");
const runner = await releaseShellRunner(fixture.env);
for (const item of fixture.cases)
  test(`production Waffle parameter lists: ${item.id}`, async () => {
    const actual = await runner(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status);
    assert.equal(actual.stdout.toString(), item.stdout);
    assert.equal(
      actual.stderr.toString().replace(/^.*?: line (\d+):/, "/usr/bin/bash: line $1:"),
      item.stderr,
    );
  });
