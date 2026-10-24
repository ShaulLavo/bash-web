import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const cases = [
  String.raw`[[ 'a b' =~ ^(a\ b)$ ]] && echo true`,
  String.raw`pat='^(a b)$'; [[ 'a b' =~ $pat ]] && echo true`,
  String.raw`f=fff; [[ fffx =~ $f(x) ]]; echo $?; [[ ffx =~ $f(x) ]]; echo $?`,
  String.raw`[[ a=x =~ a=(x) ]]; echo $?; [[ =x =~ a=(x) ]]; echo $?`,
  String.raw`[[ @fx =~ @f(x) ]]; echo $?; [[ fx =~ @f(x) ]]; echo $?`,
  String.raw`[[ 'a  b' =~ (a  b) ]]; echo $?; [[ 'a b' =~ (a  b) ]]; echo $?; [[ 'a b' =~ (a b|c) ]]; echo $?; [[ '  c' =~ (a|  c) ]]; echo $?`,
  String.raw`[[ '< >' =~ (< >) ]] && echo true`,
  String.raw`[[ a =~ ^(a)$ ]]; echo $?; [[ a =~ ^(a|b)$ ]]; echo $?`,
  String.raw`if [[ xy =~ x+((y)) ]]; then echo Matches; fi`,
  String.raw`[[ '<' =~ (<) ]]; echo $?; [[ '>' =~ (<) ]]; echo $?`,
  String.raw`[[ '[' =~ ^([x[]) ]] && echo Matched`,
  String.raw`x=ab; [[ $x =~ ^(a|b)b$ ]] && echo y`,
  String.raw`[[ x =~ (x$|y$) ]] && echo q7`,
].concat(
  [
    "^(ab|c){2,3}$",
    "^((ab|c){2,3})+$",
    "^(a|)b?$",
    "^()$",
    "^(()|a?)*$",
    "^(a|aa)*b$",
    "^((a|b)+c?)*$",
    "^(a|b){0}$",
    "^(a|b){0,2}$",
    "^(a|b){2,}$",
    "(a^|b$)",
    "(^a|b$)",
    "(x$|y$)",
    "(^)*",
    "($)+",
    "((^|$)*)+",
    "^([[:alpha:]]|[0-9])+$",
    "^([()|]|[x[])+$",
    "^(a\\+|b\\?)$",
    "^(a|b)c|d(e|f)$",
    "(a|b)(c|d)",
    "((a)|(b))?",
    "(|a|)",
  ].flatMap((pattern) =>
    ["", "a", "ab", "abc", "cababc", "aaab", "xby", "b", "[()|", "a+"].map(
      (value) => `p='${pattern}'; [[ '${value}' =~ $p ]]; echo $?`,
    ),
  ),
  [
    String.raw`[[ a =~ (^)* ]]; echo $?; [[ a =~ ($)+ ]]; echo $?`,
    String.raw`[[ '(a|b)+' =~ ^'('a'|'b')+'$ ]]; echo $?; [[ a =~ ^('a'|"b")$ ]]; echo $?`,
    String.raw`p='(a'; [[ a =~ $p ]]; echo $?; p='a|('; [[ a =~ $p ]]; echo $?; p='(a){3,2}'; [[ a =~ $p ]]; echo $?`,
    String.raw`[[ yes || a =~ (a) ]]; echo $?; [[ '' && a =~ (a) ]]; echo $?`,
    String.raw`[[ a =~ (a) ]] && echo match; [[ b =~ (a) ]] || echo miss; [[ ! b =~ (a) ]] && echo negated`,
  ],
);
function observation(result: { status?: number | null; stdout: Buffer; stderr: Buffer }) {
  return {
    status: result.status,
    stdout: result.stdout.toString("base64"),
    stderr: result.stderr.toString("base64"),
  };
}

test("production Waffle grouped ERE agrees with GNU Bash", async (suite) => {
  const directory = resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release",
  );
  const environment = { HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C", LANG: "C" };
  const runner = await createWaffleRunner({
    tmp: environment.TMP,
    env: environment,
    fixtureDirectory: directory,
    utilityDirectory: directory,
    modulePath: resolve(directory, "shell-runtime.wasm"),
  });
  for (const script of cases) {
    await suite.test(script, async (control) => {
      const expected = spawnSync("/usr/bin/bash", ["-c", script], {
        env: { ...environment, PATH: "/usr/bin:/bin" },
      });
      assert.equal(expected.error, undefined);
      assert.equal(expected.signal, null);
      const actual = await runner(script);
      control.diagnostic(
        JSON.stringify({ script, bash: observation(expected), actual: observation(actual) }),
      );
      assert.equal(actual.crash, undefined);
      assert.deepEqual([actual.status, actual.stdout], [expected.status, expected.stdout]);
    });
  }
});
