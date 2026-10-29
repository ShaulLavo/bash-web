import assert from "node:assert/strict";
import { test } from "node:test";
import {
  api,
  prepareWaffleDirectories,
  runRoot,
  shell,
  waffleFixture,
} from "./own-shell-waffle-fixture.ts";

async function invoke(context, argv, files) {
  const fixture = await waffleFixture(context);
  await prepareWaffleDirectories(fixture.runtime, ["/workdir", "/other"]);
  for (const [path, bytes] of files)
    await fixture.runtime.filesystem.writeFile(path, new Uint8Array(Buffer.from(bytes)));
  await fixture.runtime.filesystem.drain();
  const stdout = [];
  const stderr = [];
  const status = await runRoot(
    fixture.runtime,
    api,
    shell,
    { modulePath: "", tmp: "/workdir", env: { PATH: "/other" }, fixtureDirectory: "" },
    "",
    (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
    fixture.setStop,
    argv,
  );
  return {
    status,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}
const source = `#!/bin/sh
printf '<%s>\\n' "$0" "$#" "$1" "$@"
pwd
exit 37`;
for (const name of ["run name;'$.sh", "/other/run name;'$.sh"]) {
  test(
    `WASI filename argv ${JSON.stringify(name)} keeps arguments and cwd`,
    { timeout: 15000 },
    async (context) => {
      const path = name.startsWith("/") ? name : `/workdir/${name}`;
      const result = await invoke(
        context,
        ["/bin/sh", name, "", "two words", "$x*;"],
        [[path, source]],
      );
      assert.deepEqual(result, {
        status: 37,
        stdout: `<${name}>\n<3>\n<>\n<>\n<two words>\n<$x*;>\n/workdir\n`,
        stderr: "",
      });
    },
  );
}
test("WASI named syntax error names its source and line", { timeout: 15000 }, async (context) => {
  const result = await invoke(
    context,
    ["sh", "bad.sh"],
    [["/workdir/bad.sh", "echo before\nif ; then\n"]],
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "before\n");
  assert.match(result.stderr, /bad\.sh: line 2:/);
});
for (const [name, status] of [
  ["missing.sh", 127],
  ["", 127],
  ["/other", 126],
]) {
  test(`WASI named open failure ${JSON.stringify(name)}`, { timeout: 15000 }, async (context) => {
    const result = await invoke(context, ["sh", name], [["/other/missing.sh", "echo WRONG"]]);
    assert.equal(result.status, status);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith(`${name}: `));
  });
}
for (const [bytes, status, pattern] of [
  [Buffer.from([255]), 2, /invalid UTF-8/],
  [Buffer.from(": " + " ".repeat(256 * 1024 - 2)), 0, /^$/],
  [Buffer.alloc(256 * 1024 + 1, 32), 2, /shell source limit exceeded/],
]) {
  test(`WASI named source bounds ${bytes.length} bytes`, { timeout: 15000 }, async (context) => {
    const result = await invoke(context, ["sh", "file.sh"], [["/workdir/file.sh", bytes]]);
    assert.equal(result.status, status);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, pattern);
  });
}

test(
  "WASI option-looking file works through an explicit relative path",
  { timeout: 15000 },
  async (context) => {
    const result = await invoke(
      context,
      ["sh", "./-e"],
      [["/workdir/-e", "printf '%s\\n' \"$0\""]],
    );
    assert.deepEqual(result, { status: 0, stdout: "./-e\n", stderr: "" });
  },
);

test(
  "WASI named command failure retains source line and status",
  { timeout: 15000 },
  async (context) => {
    const result = await invoke(
      context,
      ["sh", "failure.sh"],
      [["/workdir/failure.sh", "\nmissing-script-command\n"]],
    );
    assert.equal(result.status, 127);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /failure\.sh: line 2:/);
  },
);
