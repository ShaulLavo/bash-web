import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  api,
  prepareWaffleDirectories,
  runRoot,
  shell,
  waffleFixture,
} from "./own-shell-waffle-fixture.ts";

async function invoke(context: TestContext, args: string[]) {
  const fixture = await waffleFixture(context);
  await prepareWaffleDirectories(fixture.runtime, ["/tmp/spec"]);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const status = await runRoot(
    fixture.runtime,
    api,
    shell,
    { modulePath: "", tmp: "/tmp/spec", env: {}, fixtureDirectory: "" },
    "",
    (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
    fixture.setStop,
    args,
  );
  return {
    status,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

const inspect = `printf 'name=<%s> count=<%s> first=<%s>\\n' "$0" "$#" "$1"
for arg in "$@"; do printf 'arg=<%s>\\n' "$arg"; done`;
for (const entry of [
  {
    name: "explicit name and first operand",
    operands: ["zero", "one"],
    stdout: "name=<zero> count=<1> first=<one>\narg=<one>\n",
  },
  {
    name: "empty name, empty operands, spaces and literal metacharacters",
    operands: ["", "", "two words", "$x*; 'quoted'", "-c", ""],
    stdout:
      "name=<> count=<5> first=<>\narg=<>\narg=<two words>\narg=<$x*; 'quoted'>\narg=<-c>\narg=<>\n",
  },
  {
    name: "name containing spaces and no positionals",
    operands: ["zero name"],
    stdout: "name=<zero name> count=<0> first=<>\n",
  },
  {
    name: "no name uses invocation argv zero and has no positionals",
    operands: [],
    stdout: "name=</bin/sh> count=<0> first=<>\n",
  },
]) {
  test(`WASI -c ${entry.name}`, { timeout: 15000 }, async (context) => {
    const result = await invoke(context, ["/bin/sh", "-c", inspect].concat(entry.operands));
    assert.deepEqual(result, { status: 0, stdout: entry.stdout, stderr: "" });
  });
}

for (const [source, status] of [
  ["", 0],
  ["false", 1],
  ["exit 37", 37],
] as const) {
  test(
    `WASI -c preserves status ${status} for ${JSON.stringify(source)}`,
    { timeout: 15000 },
    async (context) => {
      assert.deepEqual(await invoke(context, ["sh", "-c", source, "zero", "one"]), {
        status,
        stdout: "",
        stderr: "",
      });
    },
  );
}

for (const args of [
  ["sh", "-c"],
  ["sh", "-x", "echo wrong"],
  ["sh", "-e", "script.sh"],
  ["sh", "-"],
  ["sh", "--", "script.sh"],
  ["sh", "-i", "--line-editor"],
  ["sh", "-i", "--line-editor", "fish"],
  ["sh", "-i", "--line-editor", "zsh", "extra"],
  ["sh", "-i", "--unknown", "zsh"],
]) {
  test(
    `WASI rejects unsupported startup ${JSON.stringify(args)}`,
    { timeout: 15000 },
    async (context) => {
      const result = await invoke(context, args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "shell-runtime: usage: shell-runtime [-i [--line-editor bash|zsh] [--prompt-host] | -c SCRIPT [NAME [ARG...]] | FILE [ARG...]]\n",
      );
    },
  );
}
