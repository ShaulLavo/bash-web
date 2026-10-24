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
    assertResult(actual, item);
    assert.equal(actual.stderr.toString().replaceAll(/: line \d+:/g, ":"), item.stderr);
  });

const publication: typeof fixture = JSON.parse(
  readFileSync(new URL("fixtures/shell-special-params-publication.json", import.meta.url), "utf8"),
);
assert.equal(publication.bash, fixture.bash);
for (const item of publication.cases)
  test(`production Waffle last-argument publication: ${item.name}`, async () => {
    const actual = await runner(item.script);
    assertResult(actual, item);
    if (item.name.startsWith("circular"))
      assert.equal(
        actual.stderr.toString().replaceAll(/: line \d+:/g, ":"),
        item.stderr.replaceAll(/: line \d+:/g, ":"),
      );
  });

function assertResult(
  actual: Awaited<ReturnType<typeof runner>>,
  expected: Pick<(typeof fixture.cases)[number], "status" | "stdout">,
) {
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, expected.status);
  assert.equal(actual.stdout.toString(), expected.stdout);
}

test("special parameter assertion rejects each changed result field", async () => {
  const actual = await runner(":");
  const expected = { status: 0, stdout: "" };
  assertResult(actual, expected);
  assert.throws(() => assertResult({ ...actual, status: 2 }, expected));
  assert.throws(() => assertResult({ ...actual, stdout: Buffer.from("changed") }, expected));
  assert.throws(() => assertResult({ ...actual, crash: "injected assertion control" }, expected));
});
