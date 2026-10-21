import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" };
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: "/tmp/spec",
  env,
});
const inputs = [
  "",
  "a",
  "  a b  ",
  "a:b:",
  "a::b",
  "::",
  "a: :b: ",
  "a\\ b c\\ ",
  "a\\:b:c",
  "é:中:😀",
  "\u{f0020}:a",
];
const cases = [" ", ":", ": ", "", "é"]
  .flatMap((ifs) =>
    inputs.flatMap((input) =>
      ["a", "a b", "a b c", ""].map(
        (names) =>
          `IFS='${ifs}'; read ${names} <<'EOF'\n${input}\nEOF\nprintf '%s:[%s][%s][%s][%s]\\n' "$?" "$a" "$b" "$c" "$REPLY"`,
      ),
    ),
  )
  .concat([
    "read a -r <<<'x y'; printf '%s:[%s]\\n' \"$?\" \"$a\"",
    'b=old; read a 1x b <<<\'x y z\'; printf \'%s:[%s][%s]\\n\' "$?" "$a" "$b"',
    "read <<'EOF'\n  a\\\n b  \nEOF\nprintf '[%s]\\n' \"$REPLY\"",
    'printf \'ab\\\\\' | { read a b; printf \'%s:[%s][%s]\\n\' "$?" "$a" "$b"; }',
    'printf \'a\\0b c\' | { read a b; printf \'%s:[%s][%s]\\n\' "$?" "$a" "$b"; }',
    '{ read -n5 a b; printf \'%s:[%s][%s]\\n\' "$?" "$a" "$b"; read -r tail; printf \'[%s]\\n\' "$tail"; } <<<\'x y zrest\'',
    "read -n4 a b <<<'a\\ b c'; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "read -n4 a b <<<'é 中z!'; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "IFS=': ' read -r a b <<<'x\\ y:z\\ '; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "read a a <<<'x y z'; printf '[%s]\\n' \"$a\"",
    'read IFS a b <<<\'x y z\'; printf \'[%s][%s][%s]\\n\' "$IFS" "$a" "$b"',
    "{ read 1bad; printf '%s\\n' \"$?\"; read -r a; printf '[%s]\\n' \"$a\"; } <<<'untouched'",
    "{ read -n3 1bad; printf '%s\\n' \"$?\"; read -r a; printf '[%s]\\n' \"$a\"; } <<<'untouched'",
    "IFS=: read a b <<<'a::b\\ '; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "IFS='é¢'; read a b <<<'âz'; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "IFS='é¢'; read IFS a b <<<'xéâz¢q'; printf '[%s][%s][%s]\\n' \"$IFS\" \"$a\" \"$b\"",
    "IFS='é¢'; read -r a b <<<'a\\éâ¢b'; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "IFS='é¢'; read a b <<<'a\\éâ¢b'; printf '[%s][%s]\\n' \"$a\" \"$b\"",
    "IFS='éš'; read a b <<<'oneátwo'; printf '[%s][%s]\\n' \"$a\" \"$b\"",
  ])
  .concat(
    ["-r", "-n4", "-rn4"].map(
      (options) => `IFS='éš'; read ${options} a <<<'abcá'; printf '%s:[%s]\\n' "$?" "$a"`,
    ),
  )
  .concat(
    ["", "-r", "-n4", "-rn4", "-n0"].flatMap((options) =>
      ["a", "b", "c"].map(
        (readonly) =>
          `a=oldA; b=oldB; c=oldC; readonly ${readonly}; read ${options} a b c <<<'x y z'; r=$?; printf '%s:[%s][%s][%s]\\n' "$r" "$a" "$b" "$c"; exit "$r"`,
      ),
    ),
  )
  .concat(
    ["", "-r", "-n2", "-n0"].map(
      (options) =>
        `REPLY=old; readonly REPLY; read ${options} <<<'xyz'; r=$?; printf '%s:[%s]\\n' "$r" "$REPLY"; exit "$r"`,
    ),
  );
// Expectations replay recorded GNU Bash 5.3.15 observations, the frozen scoreboard's oracle.
// Bash 5.2 (hosted Ubuntu 24.04) returns 1 for readonly non-final destinations and REPLY and
// lets `read IFS ...` change later splitting, so a live host shell is not the oracle.
// BASH_READ_SCALAR_RECORD re-records every case from /usr/bin/bash 5.3.15.
type Recorded = { script: string; status: number; stdoutBase64: string };
const bashVersion = "5.3.15(1)-release";
const fixturePath = new URL("fixtures/shell-read-scalar.json", import.meta.url);
const recordPath = process.env.BASH_READ_SCALAR_RECORD;
const recorded: Recorded[] = [];
const fixture: { bash: string; cases: Recorded[] } = recordPath
  ? { bash: liveBashVersion(), cases: [] }
  : JSON.parse(readFileSync(fixturePath, "utf8"));
assert.equal(fixture.bash, bashVersion);
const fixtureCases = new Map(fixture.cases.map((entry) => [entry.script, entry]));
if (!recordPath) assert.equal(fixtureCases.size, new Set(cases).size);
after(() => {
  if (recordPath)
    writeFileSync(
      recordPath,
      JSON.stringify({ schema: 1, bash: fixture.bash, cases: recorded }, null, 2) + "\n",
    );
});

function liveBashVersion() {
  const probe = spawnSync("/usr/bin/bash", ["-c", 'printf %s "$BASH_VERSION"']);
  assert.equal(probe.status, 0);
  return probe.stdout.toString();
}

function expectation(script: string) {
  if (!recordPath) {
    const entry = fixtureCases.get(script);
    assert.ok(entry, `missing recorded Bash observation: ${script}`);
    return { status: entry.status, stdout: Buffer.from(entry.stdoutBase64, "base64") };
  }
  const bash = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], { env });
  assert.equal(bash.error, undefined);
  assert.equal(bash.signal, null);
  recorded.push({
    script,
    status: bash.status ?? -1,
    stdoutBase64: bash.stdout.toString("base64"),
  });
  return bash;
}

for (const script of cases)
  test(`production Waffle scalar read: ${script}`, async () => {
    const bash = expectation(script);
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, bash.status);
    assert.deepEqual(actual.stdout, bash.stdout);
  });
