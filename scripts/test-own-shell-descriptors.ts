import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";
import { liveNodeWorkers } from "./node-worker-host.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  tmp: "/descriptors",
  env: { PATH: "/bin", HOME: "/", TMP: "/descriptors", LC_ALL: "C", LANG: "C" },
  fixtureDirectory: directory,
  utilityDirectory: directory,
});

async function output(script: string, expected: string) {
  const result = await run(script);
  assert.equal(result.crash, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.toString(), "");
  assert.equal(result.stdout.toString(), expected);
  assert.equal(liveNodeWorkers(), 0);
}

for (const path of ["/dev/fd/3", "/proc/self/fd/3"]) {
  test(`real Waffle ${path} reopens regular files without consuming the source`, () =>
    output(
      `printf 'one\\ntwo\\n' >f; exec 3<f; x=$(while IFS= read -r line; do printf '%s\\n' "$line"; done <${path}); IFS= read -r y <&3; printf 'x=<%s> y=<%s>\\n' "$x" "$y"`,
      "x=<one\ntwo> y=<one>\n",
    ));
}

for (const path of ["/dev/fd/4", "/proc/self/fd/4"]) {
  test(`real Waffle ${path} translates a remapped logical fd`, () =>
    output(
      `printf 'original\\nsecond\\n' >f; printf 'other\\n' >g; exec 3<f; exec 4<&3; exec 3<g; IFS= read -r x <${path}; IFS= read -r y <&4; IFS= read -r z <&3; printf '%s:%s:%s\\n' "$x" "$y" "$z"`,
      "original:original:other\n",
    ));
}

test("closed logical fd cannot reopen a private WASI fd", () =>
  output(
    "exec 3<&-; if read -r x </dev/fd/3 2>/error; then printf wrong; else printf 'closed\\n'; fi",
    "closed\n",
  ));

test("stdio regular input reopens independently", () =>
  output(
    "printf 'one\\ntwo\\n' >f; { IFS= read -r x </dev/stdin; IFS= read -r y; printf '%s:%s\\n' \"$x\" \"$y\"; } <f",
    "one:one\n",
  ));

for (const path of ["/dev/stdin", "/proc/self/fd/0"]) {
  test(`actual pipe ${path} shares its stream`, () =>
    output(
      `printf 'one\\ntwo\\n' | { IFS= read -r x <${path}; IFS= read -r y; printf '%s:%s\\n' "$x" "$y"; }`,
      "one:two\n",
    ));
}

test("regular append is independent of the original offset and append flag", () =>
  output(
    "exec 3>f; printf base >&3; printf X >>/dev/fd/3; printf Y >&3; exec 3>&-; cat f",
    "baseY",
  ));

test("regular truncation does not reset the original description offset", () =>
  output(
    "printf 'a\\nb\\n' >f; exec 3<>f; IFS= read -r x <&3; printf '12345\\n' >/dev/fd/3; IFS= read -r y <&3; printf '%s:%s\\n' \"$x\" \"$y\"",
    "a:345\n",
  ));

for (const fd of [1, 2]) {
  const path = fd === 1 ? "/dev/stdout" : "/dev/stderr";
  test(`${path} applies regular-file truncation without changing the source offset`, () =>
    output(
      `{ printf base >&${fd}; printf xy >${path}; printf Z >&${fd}; } ${fd}>f; cat f`,
      "xy\0\0Z",
    ));
}

test("utility operands and ordinary redirected substitution use the real reopen", () =>
  output(
    'printf \'one\\ntwo\\n\' >f; exec 3<f; x=$(cat </dev/fd/3); y=$(cat /proc/self/fd/3); IFS= read -r z <&3; printf \'%s:%s:%s\\n\' "$x" "$y" "$z"',
    "one\ntwo:one\ntwo:one\n",
  ));

for (const size of [3, 20000]) {
  for (const kind of ["here-doc", "here-string"]) {
    const text = "x".repeat(size);
    const redirect = kind === "here-doc" ? `<<'END'\n${text}\nlast\nEND` : `<<<'${text}\nlast'`;
    test(`${kind} ${size} retains the unexported buffer boundary`, () =>
      output(
        `{ IFS= read -r x </dev/stdin; IFS= read -r y; printf '%s:%s\\n' "\${#x}" "$y"; } ${redirect}`,
        `${size}:last\n`,
      ));
    test(`${kind} ${size} after export uses the inherited real pipe`, () =>
      output(
        `{ cat /dev/stdin >copy; if IFS= read -r x </dev/stdin; then printf wrong; else printf 'drained\\n'; fi; IFS= read -r y <copy; printf '%s\\n' "\${#y}"; } ${redirect}`,
        `drained\n${size}\n`,
      ));
  }
}
