import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

const fixture: {
  bash: string;
  cases: { name: string; script: string; status: number; stdout: string; stderr: string }[];
} = JSON.parse(
  readFileSync(new URL("fixtures/shell-special-params.json", import.meta.url), "utf8"),
);
assert.equal(fixture.bash, "5.3.15(1)-release");
const runner = await releaseShellRunner();
for (const item of fixture.cases)
  test(`production Waffle special parameter: ${item.name}`, async () => {
    const actual = await runner(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status);
    assert.equal(actual.stdout.toString(), item.stdout);
    assert.equal(actual.stderr.toString().replaceAll(/: line \d+:/g, ":"), item.stderr);
  });

const publication: typeof fixture = JSON.parse(
  readFileSync(new URL("fixtures/shell-special-params-publication.json", import.meta.url), "utf8"),
);
assert.equal(publication.bash, fixture.bash);
for (const item of publication.cases)
  test(`production Waffle last-argument publication: ${item.name}`, async () => {
    const actual = await runner(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status);
    assert.equal(actual.stdout.toString(), item.stdout);
  });
