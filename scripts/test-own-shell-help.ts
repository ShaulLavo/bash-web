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
  for (const name of [
    "help",
    "true",
    "false",
    ":",
    "printf",
    "builtin",
    "type",
    ".",
    "source",
    "mapfile",
    "readarray",
  ])
    assert.ok(text.split("\n").some((line) => line === name || line.startsWith(`${name} `)));
  assert.doesNotMatch(text, /GNU bash|linux-gnu|\b(?:ulimit|history|fc|coproc|times)\b/);
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

test("help source topics compose with local append and builtin dispatch", async () => {
  const actual = await runner(
    "echo 'local value+=s; builtin help -s source .; command help -s true' > lib; f() { local value=b; . ./lib arg; printf '%s\\n' \"$value\"; }; f; help -s true false :",
  );
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(
    actual.stdout.toString(),
    "source: source filename [arg ...]\n.: . filename [arg ...]\ntrue: true\nbs\ntrue: true\nfalse: false\n:: :\n",
  );
  assert.equal(liveNodeWorkers(), 0);
});

test("help publication preserves numeric getopts cluster progress", async () => {
  const actual = await runner(
    'set -- -ab; getopts ab opt; declare -n _=OPTIND; help -s true; getopts ab opt; printf \'%s:%s\\n\' "$opt" "$?"',
  );
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), "true: true\nb:0\n");
  assert.equal(actual.stderr.length, 0);
  assert.equal(liveNodeWorkers(), 0);
});

test("help source publication preserves prefix local ownership and return", async () => {
  const actual = await runner(
    "echo 'local value+=s; builtin help -s source .; return 7' > lib; value=outer; f() { local value=b; value=p command builtin source ./lib arg; printf '%s:%s\\n' \"$?\" \"$value\"; }; f; printf '%s\\n' \"$value\"",
  );
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(
    actual.stdout.toString(),
    "source: source filename [arg ...]\n.: . filename [arg ...]\n7:b\nouter\n",
  );
  assert.equal(actual.stderr.length, 0);
  assert.equal(liveNodeWorkers(), 0);
});
