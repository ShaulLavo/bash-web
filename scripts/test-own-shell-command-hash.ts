import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/shell-command-hash.json" with { type: "json" };
import { assertShellFixtureOutput, createShellFixtureRunner } from "./shell-fixture-runner.ts";

assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const runner = await createShellFixtureRunner();
for (const entry of fixture.cases)
  test(`production Waffle command hash: ${entry.id}`, async () => {
    const actual = await runner(entry.script);
    assertShellFixtureOutput(actual, entry);
  });

test("hash queries use real registrations, not ordinary files or literal entries", async () => {
  const actual = await runner(`
printf 'not executable' >/usr/bin/hash_ordinary_file
hash argv.py
hash -t argv.py
hash hash_ordinary_file; echo missing=$?
hash -p /literal argv.py
command -v argv.py
type -aP argv.py
hash -p /literal hash_ordinary_file
hash hash_ordinary_file; echo removed=$?
hash -t hash_ordinary_file; echo missing=$?
`);
  assertShellFixtureOutput(actual, {
    status: 0,
    stdout: "/usr/bin/argv.py\nmissing=1\n/literal\n/usr/bin/argv.py\nremoved=1\nmissing=1\n",
  });
});

test("hash remains a core builtin without utility add-ons or automatic execution caching", async () => {
  const core = await createShellFixtureRunner({ utilities: false });
  const actual = await core(`
hash -p /unregistered cat
command -v cat
cat; echo status=$?
hash -t cat
hash -r
argv.py ran
hash
`);
  assertShellFixtureOutput(actual, {
    status: 0,
    stdout: "/unregistered\nstatus=127\n/unregistered\n['ran']\nhash: hash table empty\n",
  });
});

test("2048 explicit literal paths fit the unchanged production work budget", async () => {
  const names = Array.from({ length: 2048 }, (_, i) => `q${String(i).padStart(5, "0")}`);
  const script = `hash -p /kept ${names.join(" ")}; printf 'insert=%s\\n' "$?"; hash -t ${names.at(-1)}; printf 'last=%s\\n' "$?"`;
  const actual = await runner(script);
  assertShellFixtureOutput(actual, { status: 0, stdout: "insert=0\n/kept\nlast=0\n" });
  assert.equal(actual.stderr.toString(), "");
});
