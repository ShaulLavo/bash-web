import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { releaseShellRunner } from "./release-shell-runner.ts";

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
  // A component needing more characters than any path matches nothing, without building a pattern.
  // Each 66,000-byte scalar is concatenated cheaply, since Waffle charges a checkpoint per byte.
  'x=aaaaaaaaaa; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x${x:0:6000}; set -- $x* "$x*" $x[; echo $# ${#1} ${#2} ${#3}',
  'x=aaaaaaaaaa; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x${x:0:6000}; shopt -s nullglob; set -- start $x* "$x*" $x[ end; echo $# ${#2} ${#3}',
  "x=aaaaaaaaaa; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x${x:0:6000}; for f in $x* $x[; do echo ${#f}; done; $x* 2>/dev/null; echo $?",
  "j='[{\"k\":[1,2]}'; while [ ${#j} -lt 80000 ]; do j=$j,$j; done; j=$j']'; set -- $j; echo $# ${#1}",
  // Paths over 4096 bytes are absent, beside a wildcard or under one.
  'cd "$TMP"; mkdir d; x=a; while [ ${#x} -lt 5000 ]; do x=$x$x; done; y=${x:0:4096}; x=${x:0:5000}; set -- /$x/* d*/$x /$y/* d*/$y; echo $# ${#1} ${#2} ${#3} ${#4}; for f in d*/$y; do echo ${#f}; done; shopt -s nullglob; set -- /$x/* d*/$x /$y/* d*/$y d*; echo $# $1',
  // In Waffle $TMP/$p/$m is exactly 4096 bytes (then 4095): a trailing slash is not part of that path.
  'cd "$TMP"; n=aaaaaaaaaa; n=$n$n$n$n$n$n$n$n$n$n; n=$n$n; p=$n; for i in {2..20}; do p=$p/$n; done; m=${n:0:66}; mkdir -p $p/$m; echo mk=$?; set -- $p/*/; echo $? $# ${#1}; set -- $p/*; echo $? $# ${#1}; set -- $p/*/*/ $p/*/*; echo $# ${#1} ${#2}; shopt -s nullglob; set -- $p/*/ $p/*/*/; echo $# ${#1}',
  'cd "$TMP"; n=aaaaaaaaaa; n=$n$n$n$n$n$n$n$n$n$n; n=$n$n; p=$n; for i in {2..20}; do p=$p/$n; done; m=${n:0:65}; mkdir -p $p/$m; echo mk=$?; set -- $p/*/; echo $? $# ${#1}; set -- $p/*; echo $? $# ${#1}',
  // Scalar contexts do not expand pathnames.
  'cd "$TMP"; : > a; : > ab; v=a*; printf \'<%s>\\n\' "$v"; declare w=a?; printf \'<%s>\\n\' "$w"',
  "cd \"$TMP\"; echo hi > z*; printf '<%s>\\n' z*",
  'cd "$TMP"; echo hi > ab; printf \'<%s>\\n\' "$(< a?)"',
  'cd "$TMP"; : > a; : > ab; for f in a* z*; do printf \'<%s>\\n\' "$f"; done',
  // Extglob groups without basic wildcards remain literal arguments.
  "shopt -s extglob\ncd \"$TMP\"; printf '<%s>\\n' @(q|r) +(q) ${u:-a@(}",
  // Current-main indexed compound assignments use the same unadmitted pathname fields.
  'cd "$TMP"; : > b; : > ab; : > a; : > .hidden; a=(*); printf \'<%s>\\n\' "${a[@]}"; a=(\'a*\' "a?" a*); printf \'<%s>\\n\' "${a[@]}"',
  'cd "$TMP"; : > a; : > ab; a=(before); set -f; a+=(a*); set +f; a+=(a*); shopt -s nullglob; a+=(z*); echo ${#a[@]}; printf \'<%s>\\n\' "${a[@]}"',
  'x=aaaaaaaaaa; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x$x$x$x$x; x=$x$x$x$x$x$x${x:0:6000}; a=($x* "$x*" $x[); echo $? ${#a[@]} ${#a[0]} ${#a[1]} ${#a[2]}; shopt -s nullglob; a=(start $x* "$x*" $x[ end); echo $? ${#a[@]} ${#a[1]} ${#a[2]}',
  'cd "$TMP"; mkdir d; x=a; while [ ${#x} -lt 5000 ]; do x=$x$x; done; x=${x:0:5000}; a=(/$x/* d*/$x); echo $? ${#a[@]} ${#a[0]} ${#a[1]}; shopt -s nullglob; a=(/$x/* d*/$x d*); echo $? ${#a[@]} "${a[@]}"',
  'cd "$TMP"; n=aaaaaaaaaa; n=$n$n$n$n$n$n$n$n$n$n; n=$n$n; p=$n; for i in {2..20}; do p=$p/$n; done; m=${n:0:66}; mkdir -p $p/$m; a=($p/*/); echo $? ${#a[@]} ${#a[0]}; shopt -s nullglob; a=($p/*/ $p/*/*/); echo $? ${#a[@]} ${#a[0]}',
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
  const run = await releaseShellRunner(env);
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
  test(
    "production Waffle pathname expansion consumes packed pages",
    { timeout: 20000 },
    async () => {
      const actual = await run(`cd "$TMP"
for i in {000..179}; do : > "f$i"; done
: > "é中"
set -- f*
printf '%s %s %s %s\n' "$#" "$1" "$2" "\${@: -1}"
set -- é*
printf '<%s>\n' "$1"
`);
      assert.equal(actual.crash, undefined);
      assert.equal(actual.status, 0);
      assert.equal(actual.stdout.toString(), "180 f000 f001 f179\n<é中>\n");
      assert.equal(actual.stderr.toString(), "");
      assert.equal(liveNodeWorkers(), 0);
    },
  );
}
