import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";
import { liveNodeWorkers } from "./node-worker-host.ts";

const run = await releaseShellRunner();

async function check(script, expected) {
  const actual = await run(script);
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0, actual.stderr.toString());
  assert.equal(actual.stderr.toString(), "");
  assert.equal(actual.stdout.toString(), expected);
  assert.equal(liveNodeWorkers(), 0);
}

const exact = `exec 4<&3; read -r -u3 -N65536 value; printf '%s:%s:' "$?" "\${#value}"; read -r -u4 tail; read -r -u3 next; printf '%s:%s' "$tail" "$next"; exec 3<&-; exec 4<&-`;

test("pinned Waffle regular-file exact read leaves the immediate sentinel for an alias", () =>
  check(`printf '%065536d!\\nTAIL\\n' 0 >input; exec 3<input; ${exact}`, "0:65536:!:TAIL"));

test("pinned Waffle pipe exact read progresses across capacity and leaves alias input", () =>
  check(`printf '%065536d!\\nTAIL\\n' 0 | { exec 3<&0; ${exact}; }`, "0:65536:!:TAIL"));

test("pinned Waffle final partial chunk stops before the next byte", () =>
  check(
    `printf '%065536d!\\n' 0 >input; exec 3<input; exec 4<&3; read -r -u3 -N65535 value; read -r -u4 tail; printf '%s:%s' "\${#value}" "$tail"`,
    "65535:0!",
  ));

test("pinned Waffle short exact read assigns input and returns EOF", () =>
  check(`printf abc | { read -rN65536 value; printf '%s:%s' "$?" "$value"; }`, "1:abc"));

test("pinned Waffle NUL bytes do not count and raw escapes remain literal", () =>
  check(
    `printf 'a\\0b\\\\c!\\n' | { exec 3<&0; read -rN4 value; read -r -u3 tail; printf '%s:[%s]:%s' "\${#value}" "$value" "$tail"; }`,
    "4:[ab\\c]:!",
  ));

test("pinned Waffle UTF-8 exact read leaves the next character", () =>
  check(
    `LC_ALL=C.UTF-8; printf 'é中😀!\\n' | { read -rN2 value; read -r tail; printf '[%s]:[%s]' "$value" "$tail"; }`,
    "[é中]:[😀!]",
  ));

test("pinned Waffle ordinary delimiter reads keep the next record", () =>
  check(
    `printf 'a:b\\nc\\n' | { read -r -d: a; read -r b; read -r c; printf '%s:%s:%s' "$a" "$b" "$c"; }`,
    "a:b:c",
  ));

test("pinned Waffle escaped exact read counts after continuations", () =>
  check(
    `printf 'a\\\\b\\\\\\nc!\\n' | { read -N3 value; read -r tail; printf '[%s]:[%s]' "$value" "$tail"; }`,
    "[abc]:[!]",
  ));
