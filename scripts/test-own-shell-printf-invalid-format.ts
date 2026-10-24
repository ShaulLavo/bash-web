import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/shell-printf-invalid-format.json" with { type: "json" };
import { releaseShellRunner } from "./release-shell-runner.ts";

assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const runner = await releaseShellRunner(fixture.env);
const diagnostic = (bytes: string) => bytes.replaceAll(/: line \d+:/g, ":");
function logObservation(
  identity: { id: string } | { source: string },
  actual: Awaited<ReturnType<typeof runner>>,
) {
  console.log(
    JSON.stringify({
      ...identity,
      status: actual.status,
      stdout: actual.stdout.toString("base64"),
      stderr: actual.stderr.toString("base64"),
      crash: actual.crash,
    }),
  );
}
for (const expected of fixture.cases)
  test(`production Waffle printf invalid format: ${expected.id}`, async () => {
    const actual = await runner(expected.script);
    logObservation({ id: expected.id }, actual);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, Buffer.from(expected.stdout));
    assert.equal(diagnostic(actual.stderr.toString()), diagnostic(expected.stderr));
  });

for (const source of ["printf '%C' 'A'", "printf '%S' ''", "printf '%lC' 'A'", "printf '%lS' ''"])
  test(`production Waffle printf valid unimplemented wide: ${source}`, async () => {
    const actual = await runner(source);
    logObservation({ source }, actual);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, 2);
    assert.deepEqual(actual.stdout, Buffer.alloc(0));
    assert.deepEqual(
      actual.stderr,
      Buffer.from("/usr/bin/bash: printf: unsupported format conversion\n"),
    );
  });
