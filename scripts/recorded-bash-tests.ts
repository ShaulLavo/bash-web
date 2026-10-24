import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

type RecordedCase = {
  id: string;
  code: string;
  status: number;
  stdout: string;
  stderr: string;
};
type Fixture = { version: string; cases: RecordedCase[] };

export async function recordedBashTests(family: string, fixtureUrl: URL) {
  const fixture: Fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assert.match(fixture.version, /^GNU bash, version 5\.3\.15\(/u);
  const run = await releaseShellRunner({
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    TMP: "/tmp/spec",
    LC_ALL: "C.UTF-8",
  });
  for (const entry of fixture.cases) {
    test(`recorded Bash ${family}: ${entry.id}`, async () => {
      const actual = await run(entry.code);
      assert.deepEqual(
        [actual.crash, actual.outputLimit, actual.status, actual.stdout.toString()],
        [undefined, undefined, entry.status, entry.stdout],
      );
      assertEmptyDiagnostic(entry, actual.stderr);
    });
  }
}

function assertEmptyDiagnostic(entry: RecordedCase, actual: Buffer) {
  if (entry.stderr === "") assert.equal(actual.toString(), "");
}
