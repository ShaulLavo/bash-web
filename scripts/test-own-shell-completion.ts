import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { recordedBash } from "./recorded-bash.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const fixturePath = new URL("fixtures/shell-completion.json", import.meta.url);
const fixture: { cases: { script: string }[] } = JSON.parse(readFileSync(fixturePath, "utf8"));
const oracle = recordedBash(
  fixturePath,
  undefined,
  /^GNU bash, version 5\.3\.15\(1\)-release /,
  () => "",
);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: "/tmp/spec",
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
});
for (const { script } of fixture.cases)
  test(`production Waffle completion: ${script}`, async () => {
    const expected = oracle.replay(script);
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, expected.stdout);
  });

test("production Waffle completion uses runtime files and executable registrations", async () => {
  const actual = await runner(`
mkdir -p /etc /usr/local/bin
printf 'zz_completion_user:x:1000:1000::/home/guest:/bin/bash\n' > /etc/passwd
printf 'zz_completion_group:x:1000:\n' > /etc/group
printf '# ignored\nzz_completion_service 1234/tcp\n' > /etc/services
printf '127.0.0.1 zz_completion_host\n' > /etc/hosts
printf 'not an executable registration\n' >/usr/local/bin/zz_completion_file
compgen -u zz_completion
compgen -A group zz_completion
compgen -A service zz_completion
compgen -A hostname zz_completion
PATH=/usr/local/bin compgen -c zz_completion
echo "unregistered-status:$?"
PATH=/usr/bin compgen -c argv
PATH=/usr/bin:/usr/bin compgen -c argv
`);
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 0);
  assert.equal(
    actual.stdout.toString(),
    "zz_completion_user\nzz_completion_group\nzz_completion_service\nzz_completion_host\nunregistered-status:1\nargv.py\nargv.py\nargv.py\n",
  );
});
