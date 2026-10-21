import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
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
for (const script of cases)
  test(`production Waffle positive extglob: ${script}`, { timeout: 10000 }, async () => {
    const bash = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
      env,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(bash.error, undefined);
    assert.equal(bash.signal, null);
    assert.equal(bash.status, 0, bash.stderr.toString());
    const actual = await run(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, bash.status);
    assert.deepEqual(actual.stdout, bash.stdout);
    assert.equal(liveNodeWorkers(), 0);
  });
