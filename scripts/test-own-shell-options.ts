import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRecordedShellRunner } from "./recorded-shell-runner.ts";

type Observation = { id: string; code: string; status: number; stdout: string; stderr: string };
const fixture: { version: string; cases: Observation[] } = JSON.parse(
  readFileSync(new URL("fixtures/shell-options.json", import.meta.url), "utf8"),
);
assert.match(fixture.version, /^GNU bash, version 5\.3\.15\(1\)-release/u);
const run = await createRecordedShellRunner();
for (const entry of fixture.cases) {
  test(`recorded Bash options: ${entry.id}`, async () => {
    const result = await run(entry.code);
    assert.deepEqual(
      { crash: result.crash, status: result.status, stdout: result.stdout.toString() },
      { crash: undefined, status: entry.status, stdout: entry.stdout },
    );
    assert.equal(result.stderr.toString(), entry.stderr);
  });
}
