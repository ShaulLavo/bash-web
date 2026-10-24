import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { recordedBash, recordingEnvironment, runRecordingBash } from "./recorded-bash.ts";
import { releaseShellRunner } from "./release-shell-runner.ts";

const env = recordingEnvironment();
const runner = await releaseShellRunner(env);
const cases = ["", "-r", "-n0", "-n3", "-N0", "-N3", "-n3 -N5", "-N5 -n3"]
  .flatMap((options) =>
    ["", "-d :", "-d ''"].map(
      (delimiter) =>
        `printf '  aé:b\\\\ c\\\\\\na\\0b\\nTAIL\\n' | { IFS=': '; read ${options} ${delimiter} a b c; printf '%s:[%s][%s][%s]\\n' "$?" "$a" "$b" "$c"; read -r tail; printf '[%s]\\n' "$tail"; }`,
    ),
  )
  .concat(
    ["-s", "-sn2", "-p 'Enter: '", "-rp prompt -d :", "-u3 -s -N4"].map(
      (options) =>
        `read ${options} a b <<< 'x y:z' 3<<< 'abc def'; printf '%s:[%s][%s]\\n' "$?" "$a" "$b"`,
    ),
  )
  .concat([
    `printf 'a:b:c' | { read -d : a; read -d : b; read -d : c; printf '%s:[%s][%s][%s]\\n' "$?" "$a" "$b" "$c"; }`,
    `printf 'a\\0b\\0tail' | { read -d '' a; read -rd '' b; read -rd '' c; printf '%s:[%s][%s][%s]\\n' "$?" "$a" "$b" "$c"; }`,
    `printf 'a\\\\:b:c' | { read -d : a; read -rd : b; printf '%s:[%s][%s]\\n' "$?" "$a" "$b"; }`,
    `read -N4 a b <<'END'\na b\nc\nEND\nprintf '%s:[%s][%s]\\n' "$?" "$a" "$b"`,
    `read -N2 a 1x <<< 'xyz'; printf '%s:[%s]\\n' "$?" "$a"`,
    `read -u -3; printf '%s\\n' "$?"`,
    `IFS=': '; read -rN5 a b <<< ' a:b '; printf '%s:[%s][%s]\\n' "$?" "$a" "$b"`,
    `read -rN3 a <<< 'é中😀!'; printf '%s:[%s]\\n' "$?" "$a"`,
    `LC_ALL=C read -rN3 a <<< 'abcé'; printf '%s:[%s]\\n' "$?" "$a"`,
    `REPLY=old; read -N0; printf '%s:[%s]\\n' "$?" "$REPLY"`,
    `read -N -1 a <<< 'x'; printf '%s\\n' "$?"`,
    `read -N nope a <<< 'x'; printf '%s\\n' "$?"`,
    `printf 'ab\\xc3\\xa9c\\n' | { read -r -d é x; printf '[%s]\\n' "$x"; }`,
    `printf 'a\\\\\\0 b\\0' | { read -d '' a b; printf '%s:[%s][%s]\\n' "$?" "$a" "$b"; }`,
    `read -d; printf '%s\\n' "$?"`,
    `read -p; printf '%s\\n' "$?"`,
  ]);
const oracle = recordedBash(
  new URL("fixtures/shell-read-options.json", import.meta.url),
  process.env.BASH_READ_OPTIONS_RECORD,
  /^GNU bash, version 5\.3\.15\(1\)-release /,
  () => spawnSync("/usr/bin/bash", ["--version"]).stdout.toString().split("\n")[0],
);
if (!oracle.recording) assert.equal(oracle.cases.size, new Set(cases).size);
after(() => oracle.save());
for (const script of cases)
  test(`production Waffle read options: ${script}`, async () => {
    const bash = oracle.recording ? runRecordingBash(script, env) : oracle.replay(script);
    if (oracle.recording) oracle.record(script, bash);
    const actual = await runner(script);
    assert.deepEqual(
      { status: actual.status, stdout: actual.stdout, crash: actual.crash },
      { status: bash.status, stdout: bash.stdout, crash: undefined },
    );
  });
