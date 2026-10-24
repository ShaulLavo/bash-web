import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/shell-printf-float.json" with { type: "json" };
import { createShellFixtureRunner } from "./shell-fixture-runner.ts";

assert.match(fixture.version, /^GNU bash, version 5\.3\.15\(/u);
assert.equal(
  fixture.binarySha256,
  "575e03ac834b739349a4484de481abcd06a6f7193cefc795260a32a1943f20a5",
);
const run = await createShellFixtureRunner();
for (const entry of fixture.cases) {
  test(`production Waffle recorded floating printf: ${entry.id}`, async () => {
    const result = await run(entry.code);
    assert.equal(result.crash, undefined);
    assert.equal(result.status, entry.status);
    assert.equal(result.stdout.toString(), entry.stdout);
    assert.equal(result.stderr.toString(), entry.stderr);
  });
}
