import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/shell-command-hash.json" with { type: "json" };
import { createShellFixtureRunner } from "./shell-fixture-runner.ts";

assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const runner = await createShellFixtureRunner();
for (const entry of fixture.cases)
  test(`production Waffle command hash: ${entry.id}`, async () => {
    const actual = await runner(entry.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, entry.status);
    assert.equal(actual.stdout.toString(), entry.stdout);
  });
