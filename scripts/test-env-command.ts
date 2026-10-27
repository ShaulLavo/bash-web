import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import type { commandFixture } from "../tests/helpers/env-command.ts";

const directory = new URL("../.build/node/", import.meta.url);
const harness: { commandFixture: typeof commandFixture } = await import(
  new URL("env-command.mjs", directory).href
);
const guestDirectory = new URL("../.build/shell/wasm32-wasip1/release/", import.meta.url);

test(
  "env executes an admitted WASI child with literal argv, exact environment and status",
  { timeout: 30000 },
  async (context) => {
    installNodeWorkers();
    let fixture: Awaited<ReturnType<typeof commandFixture>> | undefined;
    context.after(async () => {
      try {
        await fixture?.dispose();
      } finally {
        await stopNodeWorkers();
        assert.equal(liveNodeWorkers(), 0);
      }
    });
    fixture = await harness.commandFixture({
      fsWorker: new URL("fs.mjs", directory),
      guestWorker: new URL("shell.mjs", directory),
      env: new Uint8Array(await readFile(new URL("env.wasm", guestDirectory))),
      probe: new Uint8Array(await readFile(new URL("env-probe.wasm", guestDirectory))),
    });
    const actual = await fixture.run([
      "env",
      "-i",
      "A=new",
      "probe",
      "two words",
      "",
      "$literal;*",
      "héllo",
    ]);
    assert.deepEqual(actual, {
      outcome: { kind: "exited", code: 23, status: 23 },
      live: 0,
      stdout:
        "cwd=</tmp/spec>\narg0=<probe>\narg1=<two words>\narg2=<>\narg3=<$literal;*>\narg4=<héllo>\nenv=<A=new>\n",
      stderr: "probe stderr\n",
    });
    for (const code of [0, 23, 126, 127]) {
      const result = await fixture.run(["env", "probe", "exit", String(code)]);
      assert.deepEqual(result.outcome, { kind: "exited", code, status: code });
      assert.equal(result.live, 0);
    }
    const custom = await fixture.run([
      "env",
      "-i",
      "-C",
      "/other",
      "-a",
      "custom",
      "PWD=/different",
      "probe",
    ]);
    assert.match(custom.stdout, /^cwd=<\/other>\narg0=<custom>\nenv=<PWD=\/different>\n$/);
    const empty = await fixture.run(["env", "-i", "probe"]);
    assert.doesNotMatch(empty.stdout, /env=</);
    const inherited = await fixture.run(["env", "-u", "A", "B=kept", "probe"], {
      PATH: "/bin",
      A: "old",
      PWD: "/different",
    });
    assert.match(inherited.stdout, /^cwd=<\/tmp\/spec>/);
    assert.match(inherited.stdout, /env=<PWD=\/different>/);
    assert.match(inherited.stdout, /env=<B=kept>/);
    assert.doesNotMatch(inherited.stdout, /env=<A=/);
    const split = await fixture.run(["env", "-i", "-S", 'A=new probe "two words" ""']);
    assert.match(split.stdout, /arg0=<probe>\narg1=<two words>\narg2=<>\nenv=<A=new>/);
    for (const [args, code] of [
      [["missing-command"], 127],
      [[""], 127],
      [["/denied/probe"], 126],
      [["-0", "probe"], 125],
      [["-C", "/"], 125],
      [["--ignore-signal=INT", "probe"], 125],
      [["--default-signal", "probe"], 125],
      [["--block-signal=PIPE", "probe"], 125],
      [["--list-signal-handling", "probe"], 125],
    ] as const) {
      const result = await fixture.run(["env"].concat(Array.from(args)));
      assert.deepEqual(result.outcome, { kind: "exited", code, status: code }, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.live, 0);
    }
    context.diagnostic("ordinary command argv/env/cwd/status and usage assertions passed");
    for (const signal of [2, 9]) {
      const killed = await fixture.run(
        ["env", "probe", "spin"],
        { PATH: "/bin" },
        "/bin/env",
        signal,
      );
      assert.equal(killed.outcome.kind, "signaled");
      assert.equal(killed.outcome.code, signal);
      assert.equal(killed.live, 0);
      await fixture.runtime.filesystem.remove("/tmp/spec/ready");
    }
  },
);
