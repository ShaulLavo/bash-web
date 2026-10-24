import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/shell-printf-invalid-format.json" with { type: "json" };
import { releaseShellRunner } from "./release-shell-runner.ts";

assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const runner = await releaseShellRunner(fixture.env);
const diagnostic = (bytes: string) => bytes.replaceAll(/: line \d+:/g, ":");
for (const expected of fixture.cases)
  test(`production Waffle printf invalid format: ${expected.id}`, async () => {
    const actual = await runner(expected.script);
    console.log(
      JSON.stringify({
        id: expected.id,
        status: actual.status,
        stdout: actual.stdout.toString("base64"),
        stderr: actual.stderr.toString("base64"),
        crash: actual.crash,
      }),
    );
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, Buffer.from(expected.stdout));
    assert.equal(diagnostic(actual.stderr.toString()), diagnostic(expected.stderr));
  });
