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
  "printf '[%b]TAIL' '\\xZ\\cignored'",
  "printf '[%8b][%-8b][%08b]\\n' 'a\\tb' 'a\\tb' 'a\\tb'",
  "printf '[%*b][%*b]\\n' 8 'a\\tb' -8 'a\\tb'",
  "printf '[%05b|%05q|%05Q]\\n' 'a\\tb' 'c d' e",
  "printf '[%5b][%5b]\\n' '\\0' '\\377'",
  "printf '%5b|' a b; echo",
  "printf '[%8b][%-8b]\\n' '' ''; printf '[%8b]'",
  "printf '[%8b]TAIL%s\\n' 'a\\cignored' after; echo :$?",
  "printf '[%-8b]TAIL%s\\n' 'a\\cignored' after; echo :$?",
  "printf '[%*b]tail' bad 'a\\cignored'; echo :$?",
  "printf '[%*b]tail' bad 'a\\xZ'; echo :$?",
  "printf '[%8b]tail' 'a\\c\\xZ'; echo :$?",
  "printf '[%8.0b]tail' 'a\\cignored'; echo :$?",
  "printf '[%-8.1b]tail' 'a\\cignored'; echo :$?",
  "printf '[%8.0b]tail' '\\xZ'; echo :$?",
  "printf '[%8b]tail' 'a\\xZ' 2>&-; echo :$?",
  "printf '%8b' 'a\\tb' 1>&- 2>&-; echo :$?",
  "printf -v x '[%5b]' 'a\\tb'; printf '<%s>\\n' \"$x\"",
  "printf -v x '[%8b]TAIL' 'a\\cignored'; echo \"$?:<$x>\"",
  "printf -v x '[%-8b]' '\\0x'; echo \"$?:<$x>\"",
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
  "IFS=:; printf -v IFS ':;'; set -- 'a:b;c'; for y in $1; do echo \"<$y>\"; done; set -- left right; echo \"<$*>\"",
  "IFS=:; declare -n ref=IFS; ref=':;'; set -- 'a:b;c'; for y in $1; do echo \"<$y>\"; done; set -- left right; echo \"<$*>\"",
].concat(
  ["x", "u", "U"].flatMap((code) => [
    `x=old; printf -v x 'prefix\\${code}Z'; echo "$?:$x"`,
    `x=old; printf -v x 'prefix\\${code}Z' 2>&-; echo "$?:$x"`,
    `x=old; printf -v x '%b' 'prefix\\${code}Z'; echo "$?:$x"`,
    `x=old; printf -v x '%b' 'prefix\\${code}Z' 2>&-; echo "$?:$x"`,
  ]),
  [
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

// Bash 5.3.15 observations. Bash 5.2 differs at this boundary and can emit huge padding.
const literalCountCases = [
  {
    script: "printf '[%.2147483648b]TAIL' x",
    status: 1,
    stdout: "[]TAIL",
    stderr: "/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%5.2147483648b]TAIL' 'x\\cignored'",
    status: 0,
    stdout: "[     ",
    stderr: "/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%.2147483648b]TAIL' '\\xZ'",
    status: 1,
    stdout: "[]TAIL",
    stderr:
      "/usr/bin/bash: printf: missing hex digit for \\x\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%5.2147483648b]' x y",
    status: 1,
    stdout: "[     ][     ]",
    stderr:
      "/usr/bin/bash: printf: 2147483648: Numerical result out of range\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%5.2147483648b]TAIL' 'x\\cignored' 2>&-",
    status: 0,
    stdout: "[     ",
    stderr: "",
  },
  {
    script: "printf '[%-5.2147483648b]TAIL' 'x\\cignored'",
    status: 0,
    stdout: "[     ",
    stderr: "/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%5.2147483648b]TAIL' '\\xZ\\cignored'",
    status: 0,
    stdout: "[     ",
    stderr:
      "/usr/bin/bash: printf: missing hex digit for \\x\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%.2147483648b]TAIL' '\\xZ' 2>&-",
    status: 1,
    stdout: "[]TAIL",
    stderr: "",
  },
  {
    script: "printf '[%2147483648b]TAIL' 'a\\tb'",
    status: 1,
    stdout: "[a\tb]TAIL",
    stderr: "/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%2147483648.2147483648b]TAIL' '\\xZ'",
    status: 1,
    stdout: "[]TAIL",
    stderr:
      "/usr/bin/bash: printf: missing hex digit for \\x\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%*.2147483648b]TAIL' 5x '\\xZ\\cignored'",
    status: 0,
    stdout: "[     ",
    stderr:
      "/usr/bin/bash: printf: 5x: invalid number\n/usr/bin/bash: printf: missing hex digit for \\x\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf -v x '[%5.2147483648b]TAIL' 'a\\cignored'; echo \"$?:<$x>\"",
    status: 0,
    stdout: "0:<[     >\n",
    stderr: "/usr/bin/bash: printf: 2147483648: Numerical result out of range\n",
  },
  {
    script: "printf '[%5.2147483648s]TAIL' x",
    status: 1,
    stdout: "[",
    stderr: "/usr/bin/bash: printf: Value too large for defined data type\n",
  },
];
for (const { script, status, stdout, stderr } of literalCountCases)
  test(`production Waffle fixed literal count contract: ${script}`, async () => {
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, status);
    assert.deepEqual(actual.stdout, Buffer.from(stdout));
    assert.deepEqual(actual.stderr, Buffer.from(stderr));
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

// Declared safe assignment contract, not equality with Bash's freed-buffer behavior.
for (const prior of ["", "IFS=:; ", "unset IFS; ", "IFS=''; "])
  for (const [alias, value, expected] of [
    ["declare -n ref=IFS", ":;", "<a>\n<b>\n<c,d x>\nstar=<left:right>\n"],
    ["declare -n first=IFS; declare -n ref=first", ",", "<a:b;c>\n<d x>\nstar=<left,right>\n"],
    ["declare -n first=IFS; declare -n ref=first", "", "<a:b;c,d x>\nstar=<leftright>\n"],
  ])
    test(`production Waffle safe IFS: ${prior}${alias} -> '${value}'`, async () => {
      const actual = await runner(
        `${prior}${alias}; printf -v ref '%s' '${value}'; set -- 'a:b;c,d x'; for y in $1; do echo "<$y>"; done; set -- left right; echo "star=<$*>"`,
      );
      assert.equal(actual.crash, undefined);
      assert.equal(actual.status, 0);
      assert.deepEqual(actual.stdout, Buffer.from(expected));
      assert.equal(actual.stderr.length, 0);
    });

test("production Waffle safe local IFS restores outer scope", async () => {
  const actual = await runner(
    'IFS=:; f() { local IFS=,; local -n ref=IFS; printf -v ref ";"; set -- left right; echo "inner=<$*>"; }; f; set -- left right; echo "outer=<$*>"',
  );
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.deepEqual(actual.stdout, Buffer.from("inner=<left;right>\nouter=<left:right>\n"));
  assert.equal(actual.stderr.length, 0);
});

test("production Waffle escaped field warns before leading padding flushes", async () => {
  const actual = await runner("printf '[%5000b]tail' 'a\\xZ' 2>&1; echo :$?");
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(actual.stderr.length, 0);
  assert.deepEqual(
    actual.stdout,
    Buffer.concat([
      Buffer.from("/usr/bin/bash: printf: missing hex digit for \\x\n["),
      Buffer.alloc(4996, " "),
      Buffer.from("a\\xZ]tail:0\n"),
    ]),
  );
});

test("production Waffle escaped field overflow orders star decode count and padding", async () => {
  const actual = await runner("printf '[%*.2147483648b]TAIL' 5x '\\xZ\\cignored' 2>&1");
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(actual.stderr.length, 0);
  assert.deepEqual(
    actual.stdout,
    Buffer.from(
      "/usr/bin/bash: printf: 5x: invalid number\n/usr/bin/bash: printf: missing hex digit for \\x\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n[     ",
    ),
  );
});

test("production Waffle escaped field overflow warns before leading padding flushes", async () => {
  const actual = await runner("printf '[%5000.2147483648b]TAIL' '\\xZ' 2>&1");
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 1);
  assert.equal(actual.stderr.length, 0);
  assert.deepEqual(
    actual.stdout,
    Buffer.concat([
      Buffer.from(
        "/usr/bin/bash: printf: missing hex digit for \\x\n/usr/bin/bash: printf: 2147483648: Numerical result out of range\n[",
      ),
      Buffer.alloc(5000, " "),
      Buffer.from("]TAIL"),
    ]),
  );
});
