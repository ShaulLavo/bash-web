import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import fixture from "./fixtures/shell-source.json" with { type: "json" };
import { assertReaderOutput, recordedReaderCases } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const scripts = [
  "echo 'value=loaded; greet() { echo hello:$1:$value; }' > lib; . ./lib; greet world",
  "echo 'echo sourced' > lib; source -- ./lib",
  "echo 'echo sourced' > lib; . -- ./lib",
  "echo 'false' > lib; source ./lib; echo status=$?",
  ": > lib; false; source ./lib; echo status=$?",
  "echo 'echo before; return 7; echo BAD' > lib; source ./lib; echo status=$?",
  "echo 'return' > lib; false; . ./lib; echo status=$?",
  "echo 'exit 42' > lib; . ./lib; echo BAD",
  "echo 'echo before; echo >' > lib; . ./lib 2>/dev/null; echo status=$?",
  "source missing 2>/dev/null; echo status=$?; source 2>/dev/null; echo status=$?",
  "source . 2>/dev/null; echo status=$?",
  'set -- outer tail; echo \'printf "%s:%s:%s\\n" "$#" "$1" "$2"; shift\' > lib; . ./lib first second; printf \'%s:%s:%s\\n\' "$#" "$1" "$2"',
  "set -- outer tail; echo 'shift' > lib; . ./lib; echo count=$# arg=$1",
  "set -- outer; echo 'set -- changed more' > lib; . ./lib inner; echo count=$# arg=$1",
  "echo 'echo inner:$1; return 3' > inner; echo '. ./inner nested; echo inner-status=$?; echo outer:$1' > outer; set -- original; . ./outer supplied; echo after:$1",
  "echo 'local value=changed; echo inside:$value' > lib; f() { local value=old; . ./lib; echo function:$value; }; f; echo outside:${value-unset}",
  "echo 'local value=bad' > lib; . ./lib 2>/dev/null; echo status=$? value=${value-unset}",
  "echo 'read value; echo body:$value' > lib; . ./lib <<EOF\npayload\nEOF",
  "value=outer; value=scoped . /dev/stdin <<'END'\necho body:$value; other=retained\nEND\necho after:$value:$other",
  "printf 'echo stdin\\nreturn 6\\necho BAD\\n' | { . /dev/stdin; echo status=$?; }",
  "echo 'echo path' > lib; PATH=$PWD . lib",
  "echo 'echo fallback' > lib; PATH=/nowhere . lib",
  "echo 'echo fallback' > lib; unset PATH; . lib",
  "echo 'echo fallback' > lib; PATH= . lib",
  "echo 'echo explicit' > lib; PATH=/nowhere . ./lib",
  "echo 'echo wrapped' > lib; builtin source ./lib; command . ./lib",
  "echo 'false' > lib; set -e; . ./lib; echo BAD",
  "echo 'false; echo reached' > lib; set -e; if . ./lib; then echo conditional; fi",
  "echo 'echo retained' > lib; . ./lib > out; cat out",
  "echo 'return 5' > lib; f() { . ./lib; echo source-status=$?; }; f; echo function-status=$?",
  "echo 'echo dash' > ./-z; source -- -z",
  "echo 'set --' > lib; set -- outer; . ./lib inner; echo count=$#",
  "echo 'set -- changed' > lib; f() { set -- outer; . ./lib inner; echo after:$1; }; f",
  "echo 'set -- deep deeper' > inner; echo '. ./inner nested; echo body:$*' > outer; set -- original; . ./outer supplied; echo after:$*",
  "echo 'set -- deep deeper' > inner; echo '. ./inner; echo body:$*' > outer; set -- original; . ./outer supplied; echo after:$*",
  "echo 'set -- changed; g() { :; }; g' > lib; set -- original; . ./lib supplied; echo after:$*",
  "mkdir -p first/lib second; echo 'echo second' > second/lib; PATH=$PWD/first:$PWD/second . lib",
  "eval -- 'echo option'; echo status=$?",
  "eval -z 'echo BAD' 2>/dev/null; echo status=$?",
  "eval --; echo empty=$?; eval - 2>/dev/null; echo dash=$?",
];
const fixturePath = new URL("fixtures/shell-source.json", import.meta.url);
const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" };
const cases = recordedReaderCases({
  fixturePath,
  fixture,
  scripts,
  env: env,
  record: process.env.BASH_SOURCE_RECORD === "1",
});
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  env,
  tmp: "/tmp/spec",
  utilityDirectory: directory,
  fixtureDirectory: directory,
  modulePath: resolve(directory, "shell-runtime.wasm"),
});
for (const expected of cases) {
  test(`production Waffle source: ${expected.script}`, async () => {
    const actual = await runner(expected.script);
    assertReaderOutput(actual, expected);
    assert.deepEqual(actual.stderr, Buffer.from(expected.stderr, "base64"));
  });
}
