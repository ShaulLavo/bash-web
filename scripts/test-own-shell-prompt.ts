import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync } from "node:fs";
import { after, test } from "node:test";
import { recordedBash, runRecordingBash } from "./recorded-bash.ts";
import { releaseShellRunner } from "./release-shell-runner.ts";

const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" };
const runner = await releaseShellRunner(env);
const frozen = JSON.parse(
  readFileSync(new URL("../docs/evidence/own-shell-oracle.json", import.meta.url), "utf8"),
);
const ids = new Set([
  "brush-suite:prompt:1",
  "brush-suite:prompt:3",
  "brush-suite:prompt:8",
  "brush-suite:prompt:17",
  "brush-suite:prompt:18",
  "brush-suite:prompt:19",
  "brush-suite:prompt:20",
  "bashkit-suite:prompt-decode:4",
  "bashkit-suite:prompt-decode:20",
  "bashkit-suite:prompt-decode:27",
  "bashkit-suite:prompt-decode:34",
  "bashkit-suite:prompt-decode:41",
  "bashkit-suite:prompt-decode:59",
  "bashkit-suite:prompt-decode:70",
  "bashkit-suite:prompt-decode:79",
  "bashkit-suite:prompt-decode:121",
]);
const cases: string[] = frozen.cases
  .filter((entry: { id: string }) => ids.has(entry.id))
  .map((entry: { code: string }) => entry.code);
cases.push(
  "p='\\a\\e\\r\\n\\\\\\z\\[x\\]'; printf '[%s]\\n' \"${p@P}\"",
  "p='\\000a\\400b\\12c\\1d\\0455'; printf '[%s]\\n' \"${p@P}\"",
  "p='\"$x\" a'\"'\"'b'; x='a b'; printf '[%s]\\n' \"${p@P}\"",
  "p='${x:-\"a b\"}'; printf '[%s]\\n' \"${p@P}\"",
  "p='$@|$*'; set -- a 'b c'; printf '[%s]\\n' \"${p@P}\"",
  "p='a* ~ \"q\"'; IFS=:; printf '[%s]\\n' \"${p@P}\"; printf '[%s]\\n' ${p@P}",
  "p='${x:=changed}'; printf '[%s]\\n' \"${p@P}\" \"$x\"",
  "p='\\w|\\W'; HOME=/tmp; cd /tmp; printf '[%s]\\n' \"${p@P}\"; (shopt -u promptvars; p='$HOME'; printf '[%s]\\n' \"${p@P}\"); p='$HOME'; printf '[%s]\\n' \"${p@P}\"",
  "p='\\w|\\W'; HOME=/usr; cd /usr/local/bin; PROMPT_DIRTRIM=1; printf '[%s]\\n' \"${p@P}\"",
  "p='\\w'; HOME=/; cd /tmp; printf '[%s]\\n' \"${p@P}\"",
  "p='\\w'; HOME=/usr; cd /usr/local/bin; PROMPT_DIRTRIM=2; printf '[%s]\\n' \"${p@P}\"",
  "p='$x'; x='\\h'; printf '[%s]\\n' \"${p@P}\"",
  "p='\\'; printf '[%s]\\n' \"${p@P}\"; shopt -u promptvars; printf '[%s]\\n' \"${p@P}\"",
  "p=\"\\$'literal'\"; printf '[%s]\\n' \"${p@P}\"",
  "p='\\w'; HOME=/tmp; mkdir '/tmp/bash-web-expansion-transform-prompt-$((2+3))'; cd '/tmp/bash-web-expansion-transform-prompt-$((2+3))'; printf '[%s]\\n' \"${p@P}\"",
);
cases.push(
  "p='\\303\\251\\360\\237\\231\\202'; printf '[%s]\\n' \"${p@P}\"",
  "p='\\044x|\\140echo CS\\140'; x=VALUE; printf '[%s]\\n' \"${p@P}\"",
  "p='\\\\$HOME'; printf '[%s]\\n' \"${p@P}\"",
  "p='${v@Q}'; v=\"a'b\"; printf '[%s]\\n' \"${p@P}\"",
  "p='done'; a='${p@P}'; b='${a@P}'; printf '[%s]\\n' \"${b@P}\"",
  'x=a; printf \'[%s]\\n\' "${w:-${x@Q}}" "${x#${x@Q}}"',
);
const oracle = recordedBash(
  new URL("fixtures/shell-prompt.json", import.meta.url),
  process.env.BASH_PROMPT_RECORD,
  /^GNU bash, version 5\.3\.15\(1\)-release /,
  () => {
    const probe = spawnSync("/usr/bin/bash", ["--version"]);
    assert.equal(probe.status, 0);
    return probe.stdout.toString().split("\n")[0];
  },
);
function observe(script: string) {
  if (!oracle.recording) return oracle.replay(script);
  const expected = runRecordingBash(script, env, "/tmp");
  oracle.record(script, expected);
  return expected;
}

const missingEuidScript: string = frozen.cases.find(
  (entry: { id: string }) => entry.id === "brush-suite:prompt:21",
).code;
const injectionDirectory = "/tmp/bash-web-expansion-transform-prompt-$((2+3))";
if (oracle.recording) assert.equal(existsSync(injectionDirectory), false);
after(() => {
  oracle.save();
  if (oracle.recording && existsSync(injectionDirectory)) rmdirSync(injectionDirectory);
});
for (const script of cases)
  test(`production Waffle prompt: ${script}`, async () => {
    const expected = observe(script);
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, expected.status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, expected.stdout);
  });

test("production Waffle prompts require an EUID fact for the privilege marker", async () => {
  const expected = observe(missingEuidScript);
  const actual = await runner(missingEuidScript);
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 2);
  assert.equal(
    actual.stdout.toString(),
    expected.stdout.toString().split("\n").slice(0, 2).join("\n") + "\n",
  );
});
