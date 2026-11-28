import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  api,
  shell,
  waffleFixture,
  prepareWaffleDirectories,
} from "../own-shell-waffle-fixture.ts";

/** Exit comes from the shared outcome; stdout can still be in flight to the caller. */
async function outputIncluding(output: readonly string[], expected: string) {
  const hangCap = Date.now() + 10_000;
  while (!output.join("").includes(expected) && Date.now() < hangCap) await delay(5);
  return output.join("");
}

async function fixture(context: TestContext) {
  const { runtime } = await waffleFixture(context);
  const parent = await api.createSignalParent(runtime);
  context.after(parent.dispose);
  await prepareWaffleDirectories(runtime, ["/bin"]);
  await runtime.filesystem.writeFile("/bin/bash", new Uint8Array());
  await runtime.filesystem.drain();
  runtime.registerAdapter(
    "bash",
    api.guestLauncher(runtime, new URL("../../../.build/node/shell.mjs", import.meta.url).href),
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
  "rejected registrations leave the default self-signal disposition in effect",
  { timeout: 60000 },
  async (context) => {
    const f = await fixture(context);
    const child = await f.spawn(
      `trap '' INT; printf 'ignore:%s\\n' $?; trap 'printf forbidden' INT; printf 'handler:%s\\n' $?; [ "$BASHPID" = "$$" ] && printf 'pid-matches\\n'; kill -INT $$; printf forbidden`,
    );
    assert.deepEqual(await child.exit, { kind: "signaled", code: 2, status: 130 });
    const output = await outputIncluding(f.parent.output, "pid-matches\n");
    assert.match(output, /ignore:1\n/);
    assert.match(output, /handler:1\n/);
    assert.match(output, /pid-matches\n/);
    assert.doesNotMatch(output, /forbidden/);
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
      const output = await outputIncluding(f.parent.output, `self:${child.pid}\n`);
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
