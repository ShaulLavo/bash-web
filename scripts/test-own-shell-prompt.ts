import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { recordedBash } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" };
const directory = resolve(
  process.env.SHELL_PROMPT_GUEST_DIR ?? process.env.CARGO_TARGET_DIR ?? ".build/shell",
  process.env.SHELL_PROMPT_GUEST_DIR ? "" : "wasm32-wasip1/release",
);
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: env.TMP,
  env,
});
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
  "brush-suite:prompt:21",
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
const injectionDirectory = "/tmp/bash-web-expansion-transform-prompt-$((2+3))";
if (oracle.recording) assert.equal(existsSync(injectionDirectory), false);
after(() => {
  oracle.save();
  if (oracle.recording && existsSync(injectionDirectory)) rmdirSync(injectionDirectory);
});
for (const script of cases)
  test(`production Waffle prompt: ${script}`, async () => {
    let expected;
    if (oracle.recording) {
      const bash = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
        env,
        cwd: "/tmp",
        timeout: 5000,
      });
      assert.equal(bash.error, undefined);
      assert.equal(bash.signal, null);
      expected = { status: bash.status ?? -1, stdout: bash.stdout };
      oracle.record(script, expected);
    } else expected = oracle.replay(script);
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, expected.status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, expected.stdout);
  });
