import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

type Fixture = {
  bash: string;
  cases: { name: string; script: string; status: number; stdout: string; stderr: string }[];
};
const fixture: Fixture = JSON.parse(
  readFileSync(new URL("fixtures/shell-test-argv.json", import.meta.url), "utf8"),
);
assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const runner = await releaseShellRunner();

test("production Waffle scalar test argv matches all recorded counts and operators", async () => {
  const source = fixture.cases
    .map((entry, index) => `${entry.script}\nprintf '\\ncase${index}:%s\\n' "$?"`)
    .join("\n");
  const expected = fixture.cases
    .map((entry, index) => `${entry.stdout}\ncase${index}:${entry.status}\n`)
    .join("");
  const actual = await runner(source);
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), expected);
  assert.ok(actual.stderr.length > 0, "malformed argv must still diagnose errors");
});

for (const entry of fixture.cases.filter((entry) => entry.name.startsWith("oils:"))) {
  test(`production Waffle scalar test argv: ${entry.name}`, async () => {
    const actual = await runner(entry.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, entry.status);
    assert.equal(actual.stdout.toString(), entry.stdout);
    assert.equal(actual.stderr.toString(), entry.stderr);
  });
}
