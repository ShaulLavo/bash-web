import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import fixture from "./fixtures/shell-select.json" with { type: "json" };
import { assertReaderOutput, recordedReaderCases } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const selection = 'select x in a b; do printf "<%s>|<%s>\\n" "$x" "$REPLY"; break; done';
const inputs = [
  "1",
  "2",
  "01",
  "+1",
  "-1",
  " 1 ",
  "\t2\t",
  "0",
  "3",
  "1+0",
  "0x1",
  "1a",
  "999999999999999999999999",
  "\\1",
  "1\\\n",
  "\x001",
  "1\x00",
  "1\r",
  "1\\x",
  "",
  " ",
  "\v1\f",
];
const repairScripts = [
  'REPLY=old; x=old; select x in a; do echo BAD; break; done 0>f; printf "s=%s reply=<%s> x=<%s>\\n" "$?" "$REPLY" "$x"',
  "set -e; select x in a; do echo BAD; break; done 0>f",
  'REPLY=old; x=old; select x in a; do echo BAD; break; done 0<.; printf "s=%s reply=<%s> x=<%s>\\n" "$?" "$REPLY" "$x"',
  "set -e; readonly REPLY=old; select x in a; do break; done <<EOF\n1\nEOF",
  "set -e; readonly REPLY=old; if select x in a; do echo BAD; break; done <<EOF\n1\nEOF\nthen echo yes; else echo no; fi; echo alive",
  "readonly REPLY=old; select x in a; do break; done <<EOF\n1\nEOF\necho status=$?",
  "select 1 in; do :; done; echo status=$?",
  "select 1 in a; do echo BAD; done; echo status=$?",
  'i=0; select 1 in $((i+=1)); do :; done; echo "$?:$i"',
];
const scripts = inputs
  .map((input) => {
    const bytes = Array.from(
      Buffer.from(input),
      (byte) => `\\${byte.toString(8).padStart(3, "0")}`,
    ).join("");
    return `printf '${bytes}\\n' | ${selection}`;
  })
  .concat(
    [
      "echo 1 | select opt in a b c; do echo \"selected: $opt\"; break; done; echo 'after select'",
      'echo 2 | select item in alpha beta gamma; do echo "got: $item"; break; done',
      'echo 1 | select x in one two three; do echo "REPLY=$REPLY x=$x"; break; done',
      "echo 9 | select x in a b c; do echo \"x='$x' REPLY=$REPLY\"; break; done",
      'printf "1\\n2\\n3\\n" | select x in a b c; do echo "$x"; if [ "$REPLY" = 3 ]; then break; fi; done',
      'echo 1 | select x in a b; do echo "$x"; done',
      'x=old; REPLY=old; select x in a b; do echo BAD; done; printf "s=%s reply=<%s> x=<%s>\\n" "$?" "$REPLY" "$x"',
      "printf 2 | select x in a b; do echo BAD; done",
      'printf "1\\n" | { readonly x; select x in a; do echo BAD; break; done; echo s=$?; }',
      'printf "1\\n" | { readonly REPLY=old; select x in a; do echo BAD; break; done; echo s=$?; }',
      'printf "1\\n" | select x in a; do echo OK; break; done 2>&-; echo s=$?',
      'REPLY=kept; set -- a b; select x in; do echo BAD; done; echo "$?:$REPLY"',
      "set --; select x; do echo BAD; done; echo s=$?",
      'printf "2\\n" | { set -- "a b" c; select x; do printf "<%s>" "$x"; break; done; }',
      'printf "\\n2\\n" | select x in a b; do echo "$x"; break; done',
      'printf "1\\n2\\n" | select x in a b; do echo "$x"; REPLY=; done',
      'printf "1\\n2\\n" | select x in "" "a b"; do printf "<%s>\\n" "$x"; done',
      'printf "1\\n" | { IFS=1; select x in a b; do printf "<%s>:<%s>" "$x" "$REPLY"; break; done; }',
      "printf \"1\\n\" | { PS3='$(echo BAD)$x'; select x in a b; do break; done; }",
      'printf "1\\n2\\n" | { PS3="pick> "; select x in a b; do echo "$x"; PS3="next> "; done; }',
      'printf "1\\n" | { PS3=; select x in a; do break; done; }',
      'printf "1\\n" | select x in a b c d e f g h i j k; do break; done',
      'printf "1\\n2\\n" | { select x in a b; do echo "$x"; continue; echo BAD; done; }',
      'printf "1\\n2\\n" | { for i in A B; do select x in a b; do echo "$i:$x"; continue 2; done; echo BAD; done; }',
      'printf "1\\n" | { for i in A B; do select x in a b; do echo "$i:$x"; break 2; done; echo BAD; done; echo done; }',
      'printf "1\\n2\\n" | { select x in a b; do for y in c d; do echo "$x:$y"; continue 2; done; done; }',
      'printf "1\\n2\\n" | { select x in a b; do select y in c d; do echo "$x:$y"; break 2; done; done; }',
      'printf "1\\nTAIL\\n" | { select x in a b; do break; done; read -r tail; echo "$tail"; }',
      'printf "1\\n" | { v="a b"; select x in $v; do v=changed; echo "$x"; break; done; }',
      'printf "1\\n" | { select x in "$(printf first)" second; do echo "$x"; break; done; }',
      'printf "1\\n" | select x in a; do false; break; done; echo s=$?',
      'set -e; printf "1\\n" | select x in a; do false; done; echo BAD',
      'printf "1\\n" | { select x in a; do exit 7; done; }',
      'printf "1\\n" | { f() { select x in a; do return 7; done; }; f; echo s=$?; }',
      'REPLY=old; x=old; select x in a; do echo BAD; done <&-; printf "s=%s reply=%s x=%s\\n" "$?" "$REPLY" "$x"',
    ],
    repairScripts,
  );

const fixturePath = new URL("fixtures/shell-select.json", import.meta.url);
const environment = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  TMP: "/tmp/spec",
  LC_ALL: "C.UTF-8",
};
const cases = recordedReaderCases({
  fixturePath,
  fixture,
  scripts,
  env: environment,
  record: process.env.BASH_SELECT_RECORD === "1",
});
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  env: environment,
  tmp: "/tmp/spec",
  utilityDirectory: directory,
  fixtureDirectory: directory,
  modulePath: resolve(directory, "shell-runtime.wasm"),
});
for (const expected of cases)
  test(`production Waffle select: ${expected.script}`, async () => {
    const actual = await runner(expected.script);
    assertReaderOutput(actual, expected);
    // Runtime errors retain their own diagnostic spelling. Menu and prompt bytes are exact.
    if (!expected.script.includes("readonly") || repairScripts.includes(expected.script))
      assert.deepEqual(actual.stderr, Buffer.from(expected.stderr, "base64"));
    else {
      const stderr = Buffer.from(expected.stderr, "base64");
      const prefix = stderr.subarray(0, stderr.indexOf("/usr/bin/bash:"));
      assert.deepEqual(actual.stderr.subarray(0, prefix.length), prefix);
      assert.ok(actual.stderr.length > prefix.length);
    }
  });
