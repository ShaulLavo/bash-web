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
  "self targets honor root ignores and dispatch a caught signal before the next command",
  { timeout: 60000 },
  async (context) => {
    const f = await fixture(context);
    const child = await f.spawn(
      `trap '' INT; kill -INT $$; printf 'ignored:%s\\n' $?; trap 'printf "handler:%s\\n" $?' INT; kill -INT $$; printf 'caught:%s\\n' $?; trap '' TERM; (trap - TERM; kill -TERM $$; printf 'root:%s\\n' $?); [ "$BASHPID" = "$$" ] && printf pid-matches`,
    );
    assert.deepEqual(await child.exit, { kind: "exited", code: 0, status: 0 });
    assert.equal(
      await outputIncluding(f.parent.output, "pid-matches"),
      "ignored:0\nhandler:0\ncaught:0\nroot:0\npid-matches",
    );
  },
);

for (const [name, signal] of [
  ["INT", 2],
  ["TERM", 15],
  ["HUP", 1],
  ["QUIT", 3],
] as const) {
  test(`a delivered ${name} runs its handler before EXIT`, { timeout: 60000 }, async (context) => {
    const f = await fixture(context);
    const child = await f.spawn(
      `trap 'printf "handled\\n"; exit 17' ${name}; trap 'printf "cleanup:%s\\n" $?' EXIT; printf 'ready\\n'; while :; do :; done`,
    );
    assert.match(await outputIncluding(f.parent.output, "ready\n"), /ready\n/);
    await (await f.runtime.processes()).kill(child.pid, signal);
    assert.deepEqual(await child.exit, { kind: "exited", code: 17, status: 17 });
    assert.equal(
      await outputIncluding(f.parent.output, "cleanup:17\n"),
      "ready\nhandled\ncleanup:17\n",
    );
  });
}

test(
  "a caught signal interrupts wait without terminating its child",
  { timeout: 60000 },
  async (context) => {
    const f = await fixture(context);
    const child = await f.spawn(
      `trap 'printf "handler:%s\\n" $?' TERM; while :; do :; done & worker=$!; printf 'waiting\\n'; wait "$worker"; code=$?; kill "$worker"; wait "$worker"; printf 'wait:%s\\n' "$code"`,
    );
    assert.match(await outputIncluding(f.parent.output, "waiting\n"), /waiting\n/);
    await (await f.runtime.processes()).kill(child.pid, 15);
    assert.deepEqual(await child.exit, { kind: "exited", code: 0, status: 0 });
    assert.equal(
      await outputIncluding(f.parent.output, "wait:143\n"),
      "waiting\nhandler:143\nwait:143\n",
    );
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
