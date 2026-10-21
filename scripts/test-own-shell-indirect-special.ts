import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

// Bare `${!ref}` whose target is a positional or special parameter, through
// the release guest on Waffle's process path.
const runner = await releaseShellRunner();
// GNU Bash 5.3.15 (the frozen oracle's version) observations, recorded so the
// check does not depend on the CI host's Bash. Diagnostics drop line numbers.
const fixture: {
  bash: string;
  cases: { script: string; status: number; stdout: string; stderr: string }[];
} = JSON.parse(
  readFileSync(new URL("fixtures/shell-indirect-special.json", import.meta.url), "utf8"),
);
assert.equal(fixture.bash, "5.3.15(1)-release");
const cases = fixture.cases;
const normalizeDiagnostic = (bytes: Buffer) => bytes.toString().replaceAll(/: line \d+:/g, ":");
for (const { script, status, stdout, stderr } of cases)
  test(`production Waffle indirect special target: ${script}`, async () => {
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, status);
    assert.equal(actual.stdout.toString(), stdout);
    assert.equal(normalizeDiagnostic(actual.stderr), stderr);
  });
