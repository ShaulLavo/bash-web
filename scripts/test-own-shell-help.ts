import assert from "node:assert/strict";
import { test } from "node:test";
import { recordedBash } from "./recorded-bash.ts";
import { createShellFixtureRunner } from "./shell-fixture-runner.ts";
import { liveNodeWorkers } from "./node-worker-host.ts";

const oracle = recordedBash(
  new URL("fixtures/shell-help.json", import.meta.url),
  undefined,
  /^GNU bash, version 5\.3\.15\(1\)-release /,
  () => "",
);
const runner = await createShellFixtureRunner({ utilities: false });
for (const { script } of oracle.fixture.cases)
  test(`production Waffle help: ${script}`, async () => {
    const expected = oracle.replay(script);
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.deepEqual(
      { status: actual.status, stdout: actual.stdout },
      { status: expected.status, stdout: expected.stdout },
    );
    assert.equal(liveNodeWorkers(), 0);
  });

test("help lists only implemented builtin topics with bash-web identity", async () => {
  const actual = await runner("help");
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  const text = actual.stdout.toString();
  assert.match(text, /^bash-web shell builtins\n/);
  for (const name of ["help", "true", "false", ":", "printf", "builtin", "type"])
    assert.ok(text.split("\n").some((line) => line === name || line.startsWith(`${name} `)));
  assert.doesNotMatch(
    text,
    /GNU bash|linux-gnu|\b(?:ulimit|history|fc|coproc|mapfile|source|times)\b/,
  );
  assert.equal(liveNodeWorkers(), 0);
});

test("help formats original descriptions and pseudo-manpages without GNU identity", async () => {
  const actual = await runner("help help; help -- help; help -m true");
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.match(actual.stdout.toString(), /help: help \[-dms\] \[pattern \.\.\.\]/);
  assert.match(actual.stdout.toString(), /NAME\n    true - Return a successful result\./);
  assert.match(actual.stdout.toString(), /IMPLEMENTATION\n    bash-web\n/);
  assert.doesNotMatch(actual.stdout.toString(), /GNU bash|linux-gnu/);
});

test("help reports missing topics and invalid options through stderr", async () => {
  const missing = await runner("help no_such_topic");
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout.length, 0);
  assert.match(missing.stderr.toString(), /help: no help topics match `no_such_topic'/);
  const invalid = await runner("help -z");
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr.toString(), /help: -z: invalid option/);
  assert.match(invalid.stderr.toString(), /help: usage: help \[-dms\]/);
  const closed = await runner("help -z 2>&-");
  assert.equal(closed.status, 2);
});

test("help uses builtin dispatch and needs no command add-ons", async () => {
  const actual = await runner(
    "help() { echo shadow; }; builtin help -s true; command help -s false; cat",
  );
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 127);
  assert.equal(actual.stdout.toString(), "true: true\nfalse: false\n");
  assert.match(actual.stderr.toString(), /cat: command not found/);
  assert.equal(liveNodeWorkers(), 0);
});

test("help prefers exact topics to prefixes and documents its own options", async () => {
  const exact = await runner("help -d read");
  assert.equal(exact.status, 0);
  assert.equal(exact.stdout.toString(), "read - Read input into shell variables.\n");
  const own = await runner("help --help");
  assert.equal(own.status, 2);
  assert.match(own.stdout.toString(), /^help: help \[-dms\] \[pattern \.\.\.\]/);
});
