import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: "/tmp/spec",
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C", LANG: "C" },
});
const cases = [
  "printf -v x '%s, %s' Hello world; echo \"$x\"",
  "printf -vx '%s|' a b c; echo \"$x\"",
  'printf -vva value; echo "$va"',
  "printf -va ''; echo \"<$a>\"",
  "printf -v x -- '%s-' -- a; echo \"$x\"",
  "printf -v x -v y '%05d' 42; echo \"${x-unset}:$y\"",
  "printf -- -v x; echo :$?",
  'x=old; printf -v x; echo "$?:$x"',
  "printf -v; echo $?",
  "x=old; printf -v ''; echo \"$?:$x\"",
  'x=old; printf -v 2bad %s changed; echo "$?:$x"',
  'x=old; printf -vx -x fmt; echo "$?:$x"',
  "x=old; readonly x; printf -v x '%d' 3x; echo \"$?:$x\"",
  'x=global; f() { local x=local; g; echo "$x"; }; g() { printf -v x %s dynamic; printf -v y %s global; }; f; echo "$x:$y"',
  "declare -n ref=target; printf -v ref 'formatted %d' 42; echo \"$target:$ref\"",
  'target=old; readonly target; declare -n ref=target; printf -v ref %s changed; echo "$?:$ref:$target"',
  "x=old; printf -v x 'a%d:%s' 3x tail; echo \"$?:$x\"",
  "x=old; printf -v x '[%d]%bBAD' nope 'a\\cb'; echo \"$?:$x\"",
  "printf -v x 'a\\0b%s' tail; echo \"$?:<$x>\"",
  "printf -v x '%b%s' '\\0' tail; echo \"$?:<$x>\"",
  "printf -v x '%s' 'é🙂'; echo \"$x\"",
  'printf -v x %q \'a b\'; eval "y=$x"; echo "$y"',
  "printf -v x '%s' saved 1>&-; echo \"$?:$x\"",
  "printf -v IFS :; set -- 'a:b'; for x in $1; do echo \"<$x>\"; done",
  'printf -v x -- -- data; echo "$x"',
  "printf -v x '%s' -- -v; echo \"$x\"",
  'readonly x=old; printf -v x; echo "$?:$x"',
  'readonly x=old; printf -v x %s changed 2>&-; echo "$?:$x"',
  "echo -e 'unchanged\\nbytes'; printf '%05d:%q' 42 'a b'",
].concat(
  ["x", "u", "U"].flatMap((code) => [
    `x=old; printf -v x 'prefix\\${code}Z'; echo "$?:$x"`,
    `x=old; printf -v x 'prefix\\${code}Z' 2>&-; echo "$?:$x"`,
    `x=old; printf -v x '%b' 'prefix\\${code}Z'; echo "$?:$x"`,
    `x=old; printf -v x '%b' 'prefix\\${code}Z' 2>&-; echo "$?:$x"`,
  ]),
  [
    "declare -n ref=IFS; printf -v ref ':'; set -- a:b; for y in $1; do echo \"<$y>\"; done",
    'declare -n ref=IFS; ref=:; set -- a:b; for y in $1; do echo "<$y>"; done',
    'x=old; printf -v x "a%d" bad 2>&-; echo "$?:$x"',
  ],
);
const normalizeDiagnostic = (bytes: Buffer) => bytes.toString().replaceAll(/: line \d+:/g, ":");
async function observe(script: string) {
  const bash = spawnSync("/usr/bin/bash", ["-c", script], {
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  assert.equal(bash.error, undefined);
  assert.equal(bash.signal, null);
  const actual = await runner(script);
  console.log(
    JSON.stringify({
      script,
      bash: {
        status: bash.status,
        stdout: bash.stdout.toString("base64"),
        stderr: bash.stderr.toString("base64"),
      },
      actual: {
        ...actual,
        stdout: actual.stdout.toString("base64"),
        stderr: actual.stderr.toString("base64"),
      },
    }),
  );
  assert.equal(actual.crash, undefined);
  return { bash, actual };
}
for (const script of cases)
  test(`production Waffle printf scalar: ${script}`, async () => {
    const { bash, actual } = await observe(script);
    assert.equal(actual.status, bash.status);
    assert.deepEqual(actual.stdout, bash.stdout);
    assert.equal(normalizeDiagnostic(actual.stderr), normalizeDiagnostic(bash.stderr));
  });

for (const script of [
  'x=outer; x=prefix printf -v x %s assigned; echo "$x"',
  "x=old; printf -v x '%b' '\\377'; echo \"$?:$x\"",
  "x=old; printf -v 'x[0]' %s changed; echo \"$?:$x\"",
  "x=old; printf -v x 'prefix%f' 3; echo \"$?:$x\"",
])
  test(`production Waffle explicit scalar boundary: ${script}`, async () => {
    const { actual } = await observe(script);
    assert.equal(actual.status, 0);
    const expected = script.startsWith("x=outer")
      ? "outer\n"
      : script.includes("prefix%f")
        ? "2:prefix\n"
        : "2:old\n";
    assert.deepEqual(actual.stdout, Buffer.from(expected));
  });
