import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { createShellRunner } from "./bash-compat-runner.mjs";
import { recordedBash } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const scratchRoot = process.env.RUNNER_TEMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const scratch = await mkdtemp(resolve(scratchRoot, "bash-web-file-substitution-controls-"));
const activeChildren = new Map();
await mkdir(resolve(scratch, "helpers"));
const bash = createShellRunner({
  scratch,
  timeoutMs: 10000,
  activeChildren,
  onScratchCreated: undefined,
});
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
  tmp: "/tmp/spec",
  fixtureDirectory: directory,
  modulePath: resolve(directory, "shell-runtime.wasm"),
});
const observations: object[] = [];
// Expectations replay recorded GNU Bash 5.3.15 observations, the frozen scoreboard's oracle.
// Bash 5.2 (hosted Ubuntu 24.04) also captures `0<f` in backquotes and `! <f`, so a live host
// shell is not the oracle. BASH_FILE_SUBSTITUTION_RECORD re-records from /usr/bin/bash 5.3.15.
type Expected = { status: number; stdout: Buffer };
const oracle = recordedBash(
  new URL("fixtures/shell-file-substitution.json", import.meta.url),
  process.env.BASH_FILE_SUBSTITUTION_RECORD,
  /^5\.3\.15\(1\)-release$/,
  liveBashVersion,
);
after(async () => {
  try {
    assert.equal(activeChildren.size, 0);
    if (process.env.BASH_FILE_SUBSTITUTION_OUT)
      await writeFile(
        process.env.BASH_FILE_SUBSTITUTION_OUT,
        JSON.stringify(observations, null, 2) + "\n",
      );
    oracle.save();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

function liveBashVersion() {
  const probe = spawnSync("/usr/bin/bash", ["-c", 'printf %s "$BASH_VERSION"']);
  assert.equal(probe.status, 0);
  return probe.stdout.toString();
}

async function expectation(script: string): Promise<Expected> {
  if (!oracle.recording) return oracle.replay(script);
  const live = await bash("/usr/bin/bash", script, "/usr/bin:/bin", true);
  assert.equal(live.timeout, false);
  assert.equal(live.outputLimit, false);
  oracle.record(script, live);
  return live;
}

const bodies = [
  "<f",
  "0<f",
  "3<f",
  "<f;",
  "<f\n",
  "<f\n\n",
  "<f\n#comment\n",
  "<f #comment\n",
  "<f; #comment\n",
  "<f; :",
  ":; <f",
  "{ <f; }",
  "( <f )",
  "! <f",
  "<f && :",
  "false || <f",
  "<f | :",
  "<f &",
  "<f <g",
  "<f >out",
  "<f 2>err",
  "a=x <f",
  "$unset <f",
  "<f <<<here",
  "<>f",
  "<&0",
  "0<&3",
  '<"${target:=f}"',
  "<${target:=f}",
  "<$files",
  '<"$files"',
  "<missing",
  "<*",
  "<${unset}",
  "<f{,}",
  "<$(printf f; exit 7)",
  "<$(false; printf f)",
  "< <(printf streamed)",
  '<"$(printf f)"',
  '<"${unset:?target-failure}"',
  "<f\\\n",
  "<\\\nf",
];
const scripts = bodies
  .flatMap((body) => [
    `printf 'a b\\nc\\n\\n' >f; printf other >g; printf spaced >'a b'; files='a b'; exec 3<f; unset target unset; x=$( ${body}); s=$?; printf 's=%s x=<%s> target=<%s>\\n' "$s" "$x" "$target"`,
    `printf 'a b\\nc\\n\\n' >f; printf other >g; printf spaced >'a b'; files='a b'; exec 3<f; unset target unset; x=\`${body}\`; s=$?; printf 's=%s x=<%s> target=<%s>\\n' "$s" "$x" "$target"`,
  ])
  .concat([
    "printf data >f123; x=$(<f1*); printf '<%s>' \"$x\"",
    "printf '%65536s' x >f; x=$(<f); printf '%s' \"${#x}\"",
    "unset IFS; printf 'a:b:c' >:; set -- $(<${IFS:=:}); printf '<%s>' \"$@\"",
    'printf data >f; x=$(<missing 2>&-); printf \'%s:<%s>\' "$?" "$x"',
    "printf 'a b\\nc\\n' >f; set -- $(<f); printf '%s:<%s>|' \"$#\" \"$@\"",
    'printf \'a b\\nc\\n\' >f; set -- "$(<f)"; printf \'%s:<%s>|\' "$#" "$@"',
    "printf 'a:b::c\\n' >f; IFS=:; set -- $(<f); printf '<%s>\\n' \"$@\"",
    'printf \'\\n\\n\' >f; set -- $(<f); printf \'%s\' "$#"; set -- "$(<f)"; printf \':%s:<%s>\' "$#" "$1"',
    "printf 'a\\0b\\n\\0\\n' >f; x=$(<f); printf '<%s>' \"$x\"",
    "printf 'é🙂\\n' >f; x=$(<f); printf '<%s>' \"$x\"",
    'printf data >f; false; x=$(<f); printf \'%s:%s\' "$?" "$x"',
    'x=$(<missing); s=$?; printf \'%s:<%s>\' "$s" "$x"',
    "set -e; x=$(<missing); printf BAD",
    'printf data >f; x=$(<f)$(exit 7); printf \'%s:<%s>\' "$?" "$x"',
    'printf data >f; x=$(exit 7)$(<f); printf \'%s:<%s>\' "$?" "$x"',
    'printf data >f; unset target; printf \'%s:%s\' "$(<${target:=f})" "$target"',
    'printf data >f; unset target; x=$(<${target:=f} 2>err); printf \'<%s>:<%s>\' "$x" "$target"',
    'printf data >f; x=$(<f >out); printf \'<%s>:<%s>\' "$x" "$(<out)"',
    'printf data >f; printf \'<%s>|<%s>\' "$(<f)" "`0<f`"',
    'printf data >f; printf \'<%s>|<%s>\' pre"`0<f`" "`<f`"post',
    "printf data >f; x=${unset:-`<f`}; printf '<%s>' \"$x\"",
    "printf data >f; x=${unset:-`0<f`}; printf '<%s>' \"$x\"",
    "printf 'pipe\\n' | { x=$(</dev/stdin); printf '<%s>' \"$x\"; }",
    'exec 3<&-; x=$(</dev/fd/3); printf \'%s:<%s>\' "$?" "$x"',
    'printf data >f; x=$(<f); IFS= read -r y <f; printf \'%s:%s\' "$x" "$y"',
    "printf data >f; x=$(<f); printf '%s' \"$(printf '%s' \"$x\")\"",
  ]);

const boundaryScript = "printf '\\377' >f; printf %s \"$(<f)\"";
test(
  "recorded Bash observations cover exactly the control scripts",
  { skip: oracle.recording },
  () => {
    assert.deepEqual(
      oracle.fixture.cases.map((entry) => entry.script),
      scripts.concat([boundaryScript]),
    );
  },
);

for (const script of scripts)
  test(`production Waffle input-only substitution: ${script}`, async () => {
    const expected = await expectation(script);
    const actual = await runner(script);
    observations.push({ script, expected, actual });
    assert.equal(actual.crash, undefined);
    assert.equal(actual.outputLimit, undefined);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, expected.stdout);
  });

test("production Waffle file capture rejects unrepresentable bytes", async () => {
  const script = boundaryScript;
  const expected = await expectation(script);
  const actual = await runner(script);
  observations.push({ script, boundary: "invalid UTF-8 remains unsupported", expected, actual });
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 2);
  assert.equal(actual.stdout.length, 0);
});
