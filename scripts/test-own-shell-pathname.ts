import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

// Expectations replay recorded GNU Bash 5.3.15 observations, the frozen scoreboard's oracle;
// CI never runs the host's Bash. BASH_PATHNAME_RECORD=<fixture> re-records from
// /usr/bin/bash 5.3.15, giving every script its own empty $TMP as Waffle's fresh filesystem does.
type Recorded = { script: string; status: number; stdoutBase64: string; stderrBase64: string };
const bashVersion = "5.3.15(1)-release";
const fixturePath = new URL("fixtures/shell-pathname.json", import.meta.url);
const recordPath = process.env.BASH_PATHNAME_RECORD;

const scripts = [
  // Sorted real matches through *, ? and bracket expressions, for names and arguments.
  "cd \"$TMP\"; : > b; : > ab; : > a; printf '<%s>\\n' a* *b",
  "cd \"$TMP\"; : > a; : > ab; : > b; printf '<%s>\\n' ? [ab] [!a] [a-b]?",
  'cd "$TMP"; : > b; : > a; : > c; echo *',
  'cd "$TMP"; : > echo; e* matched name',
  'cd "$TMP"; : > a; [ a = a ] && echo test-command',
  // Quoted and escaped wildcards stay literal, including next to active ones.
  "cd \"$TMP\"; : > a; : > ab; printf '<%s>\\n' 'a*' \"a*\" a\\* a'*' \\[ab] \"a\"* '[a]'*",
  'cd "$TMP"; : > a; : > ab; v=\'a*\'; printf \'<%s>\\n\' "$v" $v "${v}"b',
  // Splitting keeps each byte's protection.
  "cd \"$TMP\"; : > a; : > ab; : > b; IFS=:; v='a*:*b'; printf '<%s>\\n' $v",
  "cd \"$TMP\"; : > yz; v='x y'; printf '<%s>\\n' $v\"*\" $v*",
  "cd \"$TMP\"; : > a; : > ab; set -- 'a* b'; printf '<%s>\\n' $1 \"$1\"",
  // Unmatched patterns stay literal by default; nullglob drops only unquoted ones.
  "cd \"$TMP\"; : > a; printf '<%s>\\n' z* '[ab' [ab z?",
  "cd \"$TMP\"; : > a; : > ab; shopt -s nullglob; printf '<%s>\\n' start z* \"z*\" 'y?' a* end",
  'cd "$TMP"; shopt -s nullglob; set -- z* y? [q]; echo $#',
  "cd \"$TMP\"; shopt -s nullglob; (printf '<%s>\\n' inner z*); printf '<%s>\\n' outer z*",
  "cd \"$TMP\"; shopt -s nullglob; printf '<%s>\\n' on z*; shopt -u nullglob; printf '<%s>\\n' off z*",
  // set -f disables pathname expansion, including for for-lists.
  "cd \"$TMP\"; : > a; : > ab; set -f; printf '<%s>\\n' a*; set +f; printf '<%s>\\n' a*",
  'cd "$TMP"; : > a; set -o noglob; for f in a*; do echo "$f"; done; set +o noglob; echo a*',
  "cd \"$TMP\"; : > x; : > y; set -f; v='*'; echo $v; set +f; echo $v",
  // Dot files need an explicit leading dot.
  "cd \"$TMP\"; : > .hidden; : > a; printf '<%s>\\n' * .h* ?hidden",
  // Directories and trailing slashes.
  "cd \"$TMP\"; mkdir -p d/x d/y; : > d/x/f; : > d/n; printf '<%s>\\n' d/*/f d/*/ d/?",
  // Many fields: an argv without patterns, and with one, stays within budget.
  'cd "$TMP"; : > a; x=$(printf \'%s\\n\' {1..20000}); set -- $x; echo $#; set -- $x a*; echo $# "${@: -1}"',
  'cd "$TMP"; for i in {1..150}; do : > f$i; done; set -- f*; echo $# $1 $2 $3',
  // One 600,000-byte field, over half the 1 MiB expansion budget, unquoted and quoted. The field is
  // built in argv from a 100 KB scalar; every byte costs Waffle a work checkpoint.
  "x=0000000000; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; set -- $x$x$x$x$x$x; echo $# ${#1}",
  'x=0000000000; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; set -- "$x$x$x$x$x$x"; echo $# ${#1}',
  // Scalar contexts do not expand pathnames.
  'cd "$TMP"; : > a; : > ab; v=a*; printf \'<%s>\\n\' "$v"; declare w=a?; printf \'<%s>\\n\' "$w"',
  "cd \"$TMP\"; echo hi > z*; printf '<%s>\\n' z*",
  'cd "$TMP"; echo hi > ab; printf \'<%s>\\n\' "$(< a?)"',
  'cd "$TMP"; : > a; : > ab; for f in a* z*; do printf \'<%s>\\n\' "$f"; done',
  // Extglob groups without basic wildcards remain literal arguments.
  "shopt -s extglob\ncd \"$TMP\"; printf '<%s>\\n' @(q|r) +(q) ${u:-a@(}",
];

// Waffle's environment; each recorded Bash script gets its own TMP.
const env = {
  TMP: "/tmp/spec",
  HOME: "/home/user",
  PATH: "/usr/bin:/bin",
  LANG: "C.utf8",
  LC_ALL: "C.utf8",
};
const fixture: { bash: string; env: typeof env; cases: Recorded[] } = recordPath
  ? { bash: liveBashVersion(), env, cases: [] }
  : JSON.parse(readFileSync(fixturePath, "utf8"));
assert.equal(fixture.bash, bashVersion);
assert.deepEqual(fixture.env, env);

function liveBashVersion() {
  const version = spawnSync("/usr/bin/bash", [
    "--noprofile",
    "--norc",
    "-c",
    'printf %s "$BASH_VERSION"',
  ]);
  assert.equal(version.error, undefined);
  assert.equal(version.status, 0);
  return version.stdout.toString();
}

if (recordPath) {
  const scratch = mkdtempSync(resolve(process.env.RUNNER_TEMP ?? tmpdir(), "bash-web-pathname-"));
  try {
    scripts.forEach((script, index) => {
      const cwd = resolve(scratch, String(index));
      mkdirSync(cwd);
      const bash = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
        env: { ...env, TMP: cwd },
        cwd,
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(bash.error, undefined);
      assert.equal(bash.signal, null);
      fixture.cases.push({
        script,
        status: bash.status ?? -1,
        stdoutBase64: bash.stdout.toString("base64"),
        stderrBase64: bash.stderr.toString("base64"),
      });
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(recordPath, JSON.stringify(fixture, null, 2) + "\n");
} else {
  const fixtureCases = new Map(fixture.cases.map((entry) => [entry.script, entry]));
  assert.deepEqual(Array.from(fixtureCases.keys()), scripts);
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
  after(() => assert.equal(liveNodeWorkers(), 0));
  for (const script of scripts)
    test(`production Waffle pathname expansion: ${script}`, { timeout: 20000 }, async () => {
      const entry = fixtureCases.get(script)!;
      const actual = await run(script);
      assert.equal(actual.crash, undefined);
      assert.equal(actual.status, entry.status);
      assert.equal(actual.stdout.toString(), Buffer.from(entry.stdoutBase64, "base64").toString());
      assert.equal(actual.stderr.toString(), Buffer.from(entry.stderrBase64, "base64").toString());
      assert.equal(liveNodeWorkers(), 0);
    });
}
