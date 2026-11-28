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
type Rejections = {
  diagnostic: string;
  cases: Readonly<Record<string, Pick<RecordedCase, "status" | "stdout">>>;
};

export async function recordedBashTests(family: string, fixtureUrl: URL, rejections?: Rejections) {
  const fixture: Fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assert.match(fixture.version, /^GNU bash, version 5\.3\.15\(/u);
  const rejected = new Map(Object.entries(rejections?.cases ?? {}));
  const ids = new Set(fixture.cases.map((entry) => entry.id));
  for (const id of rejected.keys()) assert.ok(ids.has(id), `unknown registration case: ${id}`);
  const run = await releaseShellRunner({
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    TMP: "/tmp/spec",
    LC_ALL: "C.UTF-8",
  });
  for (const entry of fixture.cases) {
    test(`recorded Bash ${family}: ${entry.id}`, async () => {
      const actual = await run(entry.code);
      const override = rejected.get(entry.id);
      const expected = override ?? entry;
      assert.deepEqual(
        [actual.crash, actual.outputLimit, actual.status, actual.stdout.toString()],
        [undefined, undefined, expected.status, expected.stdout],
      );
      if (override && rejections) {
        assert.ok(actual.stderr.toString().includes(rejections.diagnostic));
        return;
      }
      assertEmptyDiagnostic(entry, actual.stderr);
    });
  }
}

function assertEmptyDiagnostic(entry: RecordedCase, actual: Buffer) {
  if (entry.stderr === "") assert.equal(actual.toString(), "");
}
