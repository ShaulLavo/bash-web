import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { runRecordingBash } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  TMP: "/tmp/spec",
  LC_ALL: "C.utf8",
  LANG: "C.utf8",
};
const cases = [
  "printf '<%s>\\n' ~ ~/src ~:suffix; HOME=/changed; printf '<%s>\\n' ~ ~/src",
  "HOME=; printf '<%s>\\n' x=~:${HOME:=/next}:~",
  "HOME=; set -- ~ ~/src ~:suffix; printf '%s\\n' \"$#\"; printf '<%s>\\n' \"$@\"",
  'HOME=/home/tt; x=y; printf \'<%s>\\n\' ~/"b" ~"/b" ~/$x ~$x "~" \\~ ~:x',
  "HOME=/home/tt; printf '<%s>\\n' ~'' ~\"\" ''~ \"\"~ '~'/src \\~/src ~/'src'",
  "HOME=/home/tt; printf '<%s>\\n' ~\\/src ~/:~ ~:~/src x~ ~/../src ~~ ~__bash_web_missing_account__/src",
  "HOME='/home/a b*?[x]'; IFS=' /:'; set -- ~ ~/src ~:x; printf '%s\\n' \"$#\"; printf '<%s>\\n' \"$@\"",
  "HOME='/tmp/spec/*'; printf data >present; for v in ~; do printf '<%s>\\n' \"$v\"; done",
  "HOME='.'; printf data >present; for v in ~/*; do printf '<%s>\\n' \"$v\"; done",
  "HOME='/tmp/spec/*'; printf data >present; set -- ~; printf '%s:<%s>\\n' \"$#\" \"$1\"",
  "HOME=/home/tt; x='~/from-value'; printf '<%s>\\n' $x \"$x\"; y=$x; printf '<%s>\\n' \"$y\"",
  "HOME=/home/tt; x='~'; a=$x; printf '<%s>\\n' \"$a\"; printf '<%s>\\n' x=$x",
  'HOME=/home/tt; a=~/src; b=~:~/bin:~; c=foo:~; printf \'<%s>\\n\' "$a" "$b" "$c"',
  "HOME=/home/tt; a=foo:~:~/src; printf '<%s>\\n' \"$a\"",
  "HOME=/home/tt; printf '<%s>\\n' x=~ x=~:~ a=b:~ 1x=~ foo:~ a+=~ _=~/src",
  "HOME=/home/tt; printf '<%s>\\n' 'x'=~ x'='~ x\\=~ x=~'' x=~\"/src\" x=~/'src'",
  "HOME=/home/tt; printf '<%s>\\n' a=:~ a=':'~ a=\\:~ a=~':' a=~/':'~",
  'HOME=/home/tt; v=prefix; a=$v:~; b=$v~; c=~$v; printf \'<%s>\\n\' "$a" "$b" "$c"',
  "HOME=/home/tt; v=; a=~$v; b=$v~; printf '<%s>\\n' \"$a\" \"$b\"; printf '<%s>\\n' ~$v $v~",
  'HOME=/home/tt; readonly a=~/src; export b=~:~/bin; printf \'<%s>\\n\' "$a" "$b"',
  "HOME=/home/tt; f() { local a=foo:~; printf '<%s>\\n' \"$a\"; }; f",
  'HOME=/one; a=~ HOME=/two b=~; printf \'<%s>\\n\' "$a" "$b" ~',
  "HOME=/home/tt; printf '<%s>\\n' ~{/src,:suffix} {~,~/src} ~{/a,/b}/tail",
  "HOME=/home/tt; printf '<%s>\\n' ~{/src,__bash_web_missing_account__}",
  "HOME=.; printf data >~/file; IFS= read -r v <~/file; printf '<%s>\\n' \"$v\"",
  "HOME=.; printf data >'x=~'; IFS= read -r v <x=~; printf '<%s>\\n' \"$v\"",
  "HOME=/home/tt; set -- x=~:~ x=~; printf '<%s>\\n' \"$@\"",
  "HOME=/home/tt; for v in ~ ~/src x=~; do printf '<%s>\\n' \"$v\"; done",
  'HOME=/home/tt; a=~; HOME=/next; b=~; printf \'<%s>\\n\' "$a" "$b"',
  "HOME='é/🙂 space'; a=~/tail; printf '<%s>\\n' ~ \"$a\"",
  'HOME=/home/tt; a=x=~; b=x:~; export c=x=~; printf \'<%s>\\n\' "$a" "$b" "$c"; printf \'<%s>\\n\' a=x=~',
];
const boundaries = [
  {
    script: "unset HOME; printf '<%s>\\n' ~",
    stdout: "<~>\n",
    status: 0,
    reason: "unset HOME requires an account lookup contract",
  },
  {
    script: "HOME=/home/tt; unset v; printf '<%s>\\n' ${v:-~}",
    stdout: "",
    status: 2,
    reason: "lazy parameter operands are not word literals",
  },
  {
    script: "HOME=/home/tt; a=foo:~:~/src; printf '<%s>\\n' \"$a\"; a+=:~; printf '<%s>\\n' \"$a\"",
    stdout: "<foo:/home/tt:/home/tt/src>\n<foo:/home/tt:/home/tt/src>\n",
    status: 0,
    reason: "append assignment (+=) is rejected before its value expands",
  },
];
type Recorded = { script: string; status: number; stdoutBase64: string; stderrBase64: string };
const fixturePath = new URL("fixtures/shell-tilde.json", import.meta.url);
const recordPath = process.env.BASH_TILDE_RECORD;
const scripts = cases.concat(boundaries.map((entry) => entry.script));
const bashVersion = "5.3.15(1)-release";
if (recordPath) {
  const version = spawnSync(
    "/usr/bin/bash",
    ["--noprofile", "--norc", "-c", 'printf %s "$BASH_VERSION"'],
    { env },
  );
  assert.equal(version.error, undefined);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.toString(), bashVersion);
  const scratch = mkdtempSync(
    resolve(
      process.env.BASH_TILDE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir(),
      "bash-web-expansion-tilde-record-",
    ),
  );
  try {
    const recorded = scripts.map((script) => record(script, scratch));
    writeFileSync(
      recordPath,
      JSON.stringify({ schema: 1, bash: bashVersion, env, cases: recorded }, null, 2) + "\n",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  const fixture: { schema: number; bash: string; env: typeof env; cases: Recorded[] } = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  );
  assert.equal(fixture.schema, 1);
  assert.equal(fixture.bash, bashVersion);
  assert.deepEqual(fixture.env, env);
  assert.deepEqual(
    fixture.cases.map((entry) => entry.script),
    scripts,
  );
  const directory = resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release",
  );
  const run = await createWaffleRunner({
    modulePath: resolve(directory, "shell-runtime.wasm"),
    fixtureDirectory: directory,
    utilityDirectory: directory,
    tmp: env.TMP,
    env,
  });
  const observations: object[] = [];
  after(() => {
    assert.equal(liveNodeWorkers(), 0);
    if (process.env.BASH_TILDE_OUT)
      writeFileSync(process.env.BASH_TILDE_OUT, JSON.stringify(observations, null, 2) + "\n");
  });
  for (const [index, script] of scripts.entries()) {
    test(`production Waffle tilde ${index}`, async () => {
      const expected = fixture.cases[index];
      const boundary = boundaries.find((entry) => entry.script === script);
      const actual = await run(script);
      observations.push({
        script,
        expected,
        boundary: boundary?.reason,
        actual: {
          ...actual,
          stdout: actual.stdout.toString("base64"),
          stderr: actual.stderr.toString("base64"),
        },
      });
      assert.equal(actual.crash, undefined);
      assert.equal(actual.outputLimit, undefined);
      assert.equal(actual.status, boundary?.status ?? expected.status);
      assert.deepEqual(
        actual.stdout,
        boundary ? Buffer.from(boundary.stdout) : Buffer.from(expected.stdoutBase64, "base64"),
      );
    });
  }
}

function record(script: string, parent: string): Recorded {
  const cwd = mkdtempSync(resolve(parent, "case-"));
  try {
    return observeBash(script, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function observeBash(script: string, cwd: string): Recorded {
  const bash = runRecordingBash(script, env, cwd);
  return {
    script,
    status: bash.status,
    stdoutBase64: bash.stdout.toString("base64"),
    stderrBase64: bash.stderr.toString("base64"),
  };
}
