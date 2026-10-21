import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  TMP: "/tmp/spec",
  LC_ALL: "C.utf8",
  LANG: "C.utf8",
};
// These new controls use Bash 5.3.15 observations, not the host's Bash version.
// Ubuntu CI's Bash 5.2.21 differs in eight malformed-group quoted literal tails.
type Recorded = { script: string; status: number; stdoutBase64: string; stderrBase64: string };
const fixturePath = new URL("fixtures/shell-extglob.json", import.meta.url);
const fixture: { bash: string; env: typeof env; cases: Recorded[] } = JSON.parse(
  readFileSync(fixturePath, "utf8"),
);
assert.equal(fixture.bash, "5.3.15(1)-release");
assert.deepEqual(fixture.env, env);
const fixtureCases = new Map(fixture.cases.map((entry) => [entry.script, entry]));
assert.equal(fixtureCases.size, fixture.cases.length);
const recordPath = process.env.BASH_EXTGLOB_RECORD;
const recorded: Recorded[] = [];
if (recordPath) {
  const version = spawnSync("/usr/bin/bash", [
    "--noprofile",
    "--norc",
    "-c",
    'printf %s "$BASH_VERSION"',
  ]);
  assert.equal(version.error, undefined);
  assert.equal(version.signal, null);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.toString(), fixture.bash);
}
after(() => {
  if (!recordPath) return;
  assert.equal(recorded.length, fixtureCases.size);
  writeFileSync(recordPath, JSON.stringify({ ...fixture, cases: recorded }, null, 2) + "\n");
});
function expectation(script: string) {
  if (!recordPath) {
    const entry = fixtureCases.get(script);
    assert.ok(entry, `missing recorded Bash observation: ${script}`);
    return {
      status: entry.status,
      stdout: Buffer.from(entry.stdoutBase64, "base64"),
      stderr: Buffer.from(entry.stderrBase64, "base64"),
    };
  }
  const bash = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
    env,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(bash.error, undefined);
  assert.equal(bash.signal, null);
  assert.equal(bash.status, 0, bash.stderr.toString());
  recorded.push({
    script,
    status: bash.status,
    stdoutBase64: bash.stdout.toString("base64"),
    stderrBase64: bash.stderr.toString("base64"),
  });
  return bash;
}
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  tmp: env.TMP,
  env,
});
const cases = [
  "[[ --verbose == --@(help|verbose) ]]; echo $?; [[ --oops == --@(help|verbose) ]]; echo $?",
  "shopt -u extglob\n[[ aa == +(a) ]]; echo $?; [[ '' == ?(a) ]]; echo $?",
  "[[ aaaa == *(a|aa) ]]; echo $?; [[ aaab == *(a|aa) ]]; echo $?",
  "[[ abba == +(a|b) ]]; echo $?; [[ '' == +(a|b) ]]; echo $?",
  "[[ '' == +() ]]; echo $?; [[ '' == *(|a) ]]; echo $?",
  "[[ ab == ?(a|b) ]]; echo $?; [[ '' == ?(a|b) ]]; echo $?",
  "[[ '' == @() ]]; echo $?; [[ '' == @(||) ]]; echo $?; [[ x == @(||) ]]; echo $?",
  "[[ ac == @(a|ab)c ]]; echo $?; [[ abc == @(a|ab)c ]]; echo $?",
  "[[ abc == @(@(a|b)|x)+(b|c) ]]; echo $?; [[ xbcc == @(@(a|b)|x)+(b|c) ]]; echo $?",
  "[[ --no-long-option == --@(help|no-@(long|short)-option) ]]; echo $?",
  "[[ abbb == @([a-c]|x)*(b) ]]; echo $?; [[ zbbb == @([a-c]|x)*(b) ]]; echo $?",
  "p='@([)]|a[)])'; [[ 'a)' == $p ]]; echo $?; p='@([|]|x)'; [[ '|' == $p ]]; echo $?",
  "[[ 'a|b' == @('a|b'|x) ]]; echo $?; [[ a == @('a|b'|x) ]]; echo $?",
  "[[ 'a)b' == @('a)b'|x) ]]; echo $?; [[ '*' == @('*'|'?') ]]; echo $?",
  "[[ aa == '@(a)' ]]; echo $?; [[ '@(a)' == '@(a)' ]]; echo $?",
  "p='@(a|b)'; [[ a == $p ]]; echo $?; [[ a == \"$p\" ]]; echo $?",
  "p='@(a|b)'; [[ '@(a|b)' == \"$p\" ]]; echo $?",
  "p='@(a|b)'; shopt -u extglob; case a in $p) echo bad;; *) echo off;; esac",
  "p='@(a|b)'; shopt -s extglob; case a in $p) echo on;; *) echo bad;; esac",
  "p='?(a|b)'; shopt -u extglob; case 'x(a|b)' in $p) echo basic;; *) echo bad;; esac",
  "p='*(a|b)'; shopt -u extglob; case 'xxx(a|b)' in $p) echo basic;; *) echo bad;; esac",
  "shopt -s extglob\ncase abba in +(a|b)) echo repeated;; *) echo bad;; esac",
  "shopt -s extglob\ncase '' in ?(a|b)) echo empty;; *) echo bad;; esac",
  "shopt -s extglob\ncase 'a|b' in @('a|b'|c)) echo quoted;; *) echo bad;; esac",
  "[[ 'é🙂' == @(?)+(?) ]]; echo $?; [[ '🙂' == @('🙂'|x) ]]; echo $?",
  "p='@(a\\|b|c)'; [[ 'a|b' == $p ]]; echo $?; [[ a == $p ]]; echo $?",
  "p='@(a\\)b|c)'; [[ 'a)b' == $p ]]; echo $?",
  "[[ abc == @(a*)c ]]; echo $?; [[ abc == +(a*)c ]]; echo $?",
  "[[ ab == *(a|)*(|b) ]]; echo $?; [[ z == *(a|)*(|b) ]]; echo $?",
  "[[ '|()' == '|()' ]]; echo $?; [[ 'a|b' == a'|'b ]]; echo $?",
];
const reviewCases = [
  "p='@(a(b)c|x)'; [[ x == $p ]]; echo $?; [[ 'a(b)c' == $p ]]; echo $?",
  "shopt -s extglob; p='@(a(b)c|x)'; case x in $p) echo match;; *) echo miss;; esac; case 'a(b)c' in $p) echo match;; *) echo miss;; esac",
  "p='@(a(b|c)d|x)'; [[ 'a(b|c)d' == $p ]]; echo $?; [[ x == $p ]]; echo $?; [[ c == $p ]]; echo $?",
  "shopt -s extglob; p='@(a((b|c))d|x)'; case 'a((b|c))d' in $p) echo match;; *) echo miss;; esac",
  "p='@(a(@(b|c))d|x)'; [[ 'a(b)d' == $p ]]; echo $?; [[ 'a(c)d' == $p ]]; echo $?; [[ x == $p ]]; echo $?",
  "p='@([|a)'; [[ a == $p ]]; echo $?; [[ '[' == $p ]]; echo $?; [[ '@([|a)' == $p ]]; echo $?",
  "shopt -s extglob; p='@([|a)'; case a in $p) echo match;; *) echo miss;; esac",
  "p='@([a|b)'; [[ b == $p ]]; echo $?; p='@([!|a)'; [[ a == $p ]]; echo $?",
  "p='@(@([|a)|b)'; [[ b == $p ]]; echo $?; [[ a == $p ]]; echo $?",
  "p='@([a)|b])'; [[ ')' == $p ]]; echo $?; [[ '|' == $p ]]; echo $?; [[ b == $p ]]; echo $?",
  "p='[|a)'; [[ '[|a)' == $p ]]; echo $?; p='[a'; [[ '[a' == $p ]]; echo $?",
  "p='@(@(a)|[b)'; [[ '@(@(a)|[b)' == $p ]]; echo $?; [[ '@(a|[b)' == $p ]]; echo $?",
  "p='@([a|b)@(x)'; [[ '@([a|b)@(x)' == $p ]]; echo $?; [[ '@([a|b)x' == $p ]]; echo $?",
  "p='*(a'; [[ '*(a' == $p ]]; echo $?; [[ 'zz(a' == $p ]]; echo $?; p='@(*a'; [[ '@(za' == $p ]]; echo $?",
  "shopt -s extglob; p='@(@(a)|[b)'; case '@(@(a)|[b)' in $p) echo match;; *) echo miss;; esac",
  "p='[@(a|b)'; [[ '[a' == $p ]]; echo $?; [[ '[b' == $p ]]; echo $?",
  "shopt -s extglob; p='[@(a|b)'; case '[a' in $p) echo match;; *) echo miss;; esac",
  "[[ '' == +(*()|?()) ]]; echo $?; [[ 'é🙂' == +(@(?)|?()) ]]; echo $?",
];
for (const delimiter of ["|", "(", ")", "!"])
  for (const slash of ["\\", "\\\\", "\\\\\\"])
    reviewCases.push(
      `p='${slash}'; [[ 'a${delimiter}b' == @(a$p'${delimiter}'b|c) ]]; echo $?; [[ b == @(a$p'${delimiter}'b|c) ]]; echo $?; [[ c == @(a$p'${delimiter}'b|c) ]]; echo $?; [[ 'a\\${delimiter}b' == @(a$p'${delimiter}'b|c) ]]; echo $?`,
      `shopt -s extglob\np='${slash}'; case 'a${delimiter}b' in @(a$p'${delimiter}'b|c)) echo match;; *) echo miss;; esac; case b in @(a$p'${delimiter}'b|c)) echo match;; *) echo miss;; esac`,
    );
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const literalTailCases = [
  "@([\\]|x)",
  "@([|a)\\*",
  "@([|a)\\?",
  "@([|a)\\\\",
  "@([|a)\\b",
  "@([\\]|x)\\*",
  "z@([|a)\\*",
  "*@([|a)\\*",
  "@(@([\\]|x)|y)",
].map((pattern) => {
  const plain = pattern.replaceAll("\\", "");
  return `shopt -s extglob; p=${quote(pattern)}; for v in ${quote(pattern)} ${quote(plain)}; do [[ $v == $p ]]; echo $?; case $v in $p) echo 0;; *) echo 1;; esac; done`;
});
for (const ch of [
  "!",
  "#",
  "%",
  "(",
  ")",
  "*",
  "-",
  ".",
  ":",
  "=",
  "?",
  "[",
  "\\",
  "]",
  "^",
  "|",
  "b",
  "@",
  "+",
  "é",
])
  for (const prefix of ["", "$q"])
    literalTailCases.push(
      `shopt -s extglob; m='@([|a)'; q='\\'; for v in ${quote("@([|a)" + ch)} ${quote("@([|a)\\" + ch)} ${quote("@([|a)\\\\" + ch)}; do [[ $v == $m${prefix}${quote(ch)} ]]; echo $?; case $v in $m${prefix}${quote(ch)}) echo 0;; *) echo 1;; esac; done`,
    );
const scripts = cases.concat(reviewCases, literalTailCases);
assert.equal(scripts.length, 121);
assert.equal(fixtureCases.size, scripts.length);
assert.deepEqual(Array.from(fixtureCases.keys()), scripts);
for (const script of scripts)
  test(`production Waffle positive extglob: ${script}`, { timeout: 10000 }, async () => {
    const bash = expectation(script);
    assert.equal(bash.status, 0, bash.stderr.toString());
    const actual = await run(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, bash.status);
    assert.deepEqual(actual.stdout, bash.stdout);
    assert.deepEqual(actual.stderr, bash.stderr);
    assert.equal(liveNodeWorkers(), 0);
  });
