import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { api, shell, waffleFixture, prepareWaffleDirectories } from "./own-shell-waffle-fixture.ts";

async function fixture(context: TestContext) {
  const { runtime } = await waffleFixture(context);
  const parent = await api.createSignalParent(runtime);
  context.after(parent.dispose);
  await prepareWaffleDirectories(runtime, ["/bin"]);
  await runtime.filesystem.writeFile("/bin/bash", new Uint8Array());
  await runtime.filesystem.drain();
  runtime.registerAdapter(
    "bash",
    api.guestLauncher(runtime, new URL("../.build/node/shell.mjs", import.meta.url).href),
  );
  runtime.registerProgram("/bin/bash", {
    adapter: "bash",
    module: shell.module,
    cooperative: true,
  });
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const spawn = parent.spawn;
  return { runtime, parent, spawn, supervisor };
}

for (const code of [2, 130, 143]) {
  test(`installed Bash keeps exit ${code} ordinary`, { timeout: 60000 }, async (context) => {
    const f = await fixture(context);
    const child = await f.spawn(`exit ${code}; printf forbidden`);
    assert.deepEqual(await child.exit, { kind: "exited", code, status: code });
    assert.equal(f.parent.output.join(""), "");
  });
}

test(
  "self targets honor root ignores and reject unsupported caught actions",
  { timeout: 60000 },
  async (context) => {
    const f = await fixture(context);
    const child = await f.spawn(
      `trap '' INT; kill -INT $$; printf 'ignored:%s\\n' $?; trap 'printf forbidden' INT; kill -INT $$; printf 'caught:%s\\n' $?; trap '' TERM; (trap - TERM; kill -TERM $$; printf 'root:%s\\n' $?); [ "$BASHPID" = "$$" ] && printf pid-matches`,
    );
    assert.deepEqual(await child.exit, { kind: "exited", code: 0, status: 0 });
    assert.equal(f.parent.output.join(""), "ignored:0\ncaught:2\nroot:0\npid-matches");
  },
);

for (const [name, code] of [
  ["INT", 2],
  ["TERM", 15],
] as const) {
  test(
    `installed Bash self ${name} publishes a signal and stops descendants only`,
    { timeout: 60000 },
    async (context) => {
      const f = await fixture(context);
      const sibling = await f.spawn("printf sibling-ready; while :; do :; done");
      void sibling.exit.catch(() => {});
      const source = `/bin/bash -c 'printf child-ready >/ready; while :; do :; done' & while [[ ! -f /ready ]]; do :; done; printf 'self:%s\\n' $$; kill -${name} $$; printf forbidden`;
      const child = await f.spawn(source);
      assert.deepEqual(await child.exit, { kind: "signaled", code, status: 128 + code });
      const output = f.parent.output.join("");
      assert.ok(output.includes(`self:${child.pid}\n`), output);
      assert.ok(!output.includes("forbidden"), output);
      assert.ok(f.supervisor.table.get(sibling.pid), "sibling survives self signal");
      await child.cleanup();
      assert.ok(
        !Array.from(f.supervisor.table.values()).some((record) => record.parentPid === child.pid),
        "terminated shell leaves no child",
      );
      await sibling.kill();
      assert.deepEqual(await sibling.exit, { kind: "signaled", code: 9, status: 137 });
    },
  );
}
