import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { createShellRunner } from "./bash-compat-runner.mjs";
import { decode, encode, type EncodedResult, type ProcessResult } from "./fuzz-shell-results.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const supportedScripts = ["$foo-bar() { ls ; }\n\n", "foo-$(echo hi)() { ls ; }\n\n"].concat(
  [
    "foo",
    "foo-bar",
    "9foo",
    "a.b",
    "a/b",
    "a:b",
    "a@b",
    "a+b",
    "a%b",
    "a,b",
    "a?b",
    "a*b",
    "a[b]",
    "é",
    "~foo",
    "{foo}",
    "`echo $foo`",
    "foo`echo hi`",
    '`echo "x"`',
    "`echo \\x`",
    "`echo \\`x`",
  ].flatMap((name) => [
    `${name}() { printf called; }; '${name}'`,
    `function ${name} { printf called; }; '${name}'`,
  ]),
  [
    "$foo",
    "${foo}",
    "foo-$(echo hi)",
    "foo-$((1+2))",
    "foo${x:=changed}",
    'foo"bar"',
    "foo'bar'",
  ].flatMap((name) => [
    `${name}() { echo BAD_BODY; }; printf 'status=%s x=<%s>\\n' "$?" "${"$"}{x-unset}"`,
    `function ${name} { echo BAD_BODY; }; printf 'status=%s x=<%s>\\n' "$?" "${"$"}{x-unset}"`,
  ]),
  [
    "echo before; $foo() { echo BAD; }; echo same\necho next",
    "if false; then $foo() { :; }; fi; echo after",
    "false && $foo() { :; }; echo after",
    "true || $foo() { :; }; echo after",
    "f() { $foo() { :; }; echo inner; }; echo defined; f; echo outer",
    "f() { $foo() { :; }; }; echo defined",
    "( $foo() { :; }; echo inner ); echo outer",
    "eval '$foo() { :; }; echo inner'; echo outer",
    "if $foo() { :; }; then echo BAD; else echo rejected; fi; echo after",
    "$foo() { :; } || echo recovered; echo after",
    "! $foo() { :; }; echo status=$?",
    "set -e; $foo() { :; }; echo BAD",
    "set -e; $foo() { :; } || echo recovered; echo after",
    "set -e; if $foo() { :; }; then echo BAD; fi; echo after",
    "set -e; f() { $foo() { :; }; echo inner; }; f || echo BAD; echo outer",
    "set -e; ( $foo() { :; }; echo BAD ); echo BAD",
    "set -e; eval '$foo() { :; }; echo BAD'; echo BAD",
    "$foo() { :; }; command -v '$foo'; echo lookup=$?",
    "$foo() { :; } >out; echo status=$?; test -e out; echo file=$?",
    "$foo() { :; } 2>&-; echo status=$?",
    "f() {\n$foo() { :; }\n}; f\necho after",
    "\n\n$foo() { :; }\necho after",
    "function a=b { echo called; }; 'a=b'",
    "function f\\oo { :; }; echo status=$?",
    "shopt -s expand_aliases; alias def=function\ndef $foo { :; }; echo after",
    "shopt -s expand_aliases; alias make='function `echo $x` { echo called; }'\nmake\n'`echo $x`'",
    "$foo()\n{ :; }; echo after",
    "exec 2>&-; $foo() { :; }; echo status=$?",
    "foo\\\nbar() { echo called; }; foobar",
    "$foo\\\n-bar() { :; }; echo after",
    "function \\\n$foo { :; }; echo after",
  ],
);
const pending = process.env.BASH_FUNCTION_NAMES_PENDING === "1";
const scripts = pending
  ? [
      'f\\oo() { echo BAD_BODY; }; printf \'status=%s x=<%s>\\n\' "$?" "${x-unset}"',
      "'foo'() { :; }; echo status=$?",
      '"foo"() { :; }; echo status=$?',
    ]
  : supportedScripts;
const recordPath = process.env.BASH_FUNCTION_NAMES_RECORD;
const fixturePath = new URL(
  `fixtures/shell-function-names${pending ? "-pending" : ""}.json`,
  import.meta.url,
);
const version = "5.3.15(1)-release";
type Recording = { schema: number; bash: string; cases: { script: string; bash: EncodedResult }[] };
const fixture: Recording = recordPath
  ? {
      schema: 1,
      bash: execFileSync("/usr/bin/bash", ["-c", 'printf %s "$BASH_VERSION"'], {
        encoding: "utf8",
      }),
      cases: [],
    }
  : JSON.parse(readFileSync(fixturePath, "utf8"));
assert.equal(fixture.schema, 1);
assert.equal(fixture.bash, version);
const scratch = await mkdtemp(
  resolve(
    process.env.RUNNER_TEMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
    "bash-web-function-names-",
  ),
);
const activeChildren = new Map();
const bash = createShellRunner({
  scratch,
  timeoutMs: 10000,
  activeChildren,
  onScratchCreated: undefined,
});
after(async () => {
  try {
    assert.equal(activeChildren.size, 0);
    if (recordPath) await writeFile(recordPath, JSON.stringify(fixture, null, 2) + "\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = recordPath
  ? undefined
  : await createWaffleRunner({
      modulePath: resolve(directory, "shell-runtime.wasm"),
      fixtureDirectory: directory,
      utilityDirectory: directory,
      tmp: "/tmp/spec",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
    });

test("recorded Bash observations cover exactly the function-name controls", () => {
  if (recordPath) return;
  assert.deepEqual(
    fixture.cases.map((entry) => entry.script),
    scripts,
  );
});
for (const [index, script] of scripts.entries())
  test(`${recordPath ? "Bash recording" : "production Waffle"} function name: ${script}`, async () => {
    const expected = await expectation(index, script);
    assert.equal(expected.signal, null);
    assert.equal(expected.timedOut, false);
    assert.equal(expected.error, null);
    if (recordPath) return;
    assert.ok(runner);
    const actual = await runner(script);
    console.log(
      JSON.stringify({
        script,
        expected: encode(expected),
        actual: {
          ...actual,
          stdout: actual.stdout.toString("base64"),
          stderr: actual.stderr.toString("base64"),
        },
      }),
    );
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.deepEqual(
      [actual.status, actual.stdout, actual.stderr],
      [expected.status, expected.stdout, expected.stderr],
    );
  });

async function expectation(index: number, script: string): Promise<ProcessResult> {
  if (!recordPath) return decode(fixture.cases[index].bash);
  const live = await bash("/usr/bin/bash", script, "/usr/bin:/bin", false);
  assert.equal(live.timeout, false);
  assert.equal(live.outputLimit, false);
  const result = {
    status: live.status,
    stdout: live.stdout,
    stderr: live.stderr,
    signal: null,
    timedOut: live.timeout,
    error: null,
  };
  fixture.cases.push({ script, bash: encode(result) });
  return result;
}
