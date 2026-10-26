import assert from "node:assert/strict";
import { loadSortUniqObservations } from "./sort-uniq-observations.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";

const names = ["sort", "uniq"] as const;
const nodeDirectory = new URL("../.build/node/", import.meta.url);
const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const binaries = {
  sort: new Uint8Array(await readFile(resolve(directory, "sort.wasm"))),
  uniq: new Uint8Array(await readFile(resolve(directory, "uniq.wasm"))),
};
const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", LC_ALL: "C", TMPDIR: "/tmp" };

async function fixture(context: TestContext) {
  let stop = () => {};
  installNodeWorkers();
  const runtime = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
  });
  context.after(async () => {
    stop();
    try {
      await runtime.dispose();
    } finally {
      await stopNodeWorkers();
      assert.equal(liveNodeWorkers(), 0);
    }
  });
  for (const path of ["/tmp/spec", "/bin", "/home/user"]) await runtime.filesystem.mkdirp(path);
  const loads = { sort: 0, uniq: 0 };
  const installations = new Map<string, Awaited<ReturnType<typeof api.installSort>>>();
  for (const name of names) {
    const install = name === "sort" ? api.installSort : api.installUniq;
    installations.set(
      name,
      await install(runtime, {
        workerUrl: new URL("shell.mjs", nodeDirectory),
        source: () => {
          loads[name]++;
          return binaries[name];
        },
      }),
    );
  }
  await runtime.filesystem.drain();
  async function execute(script: string) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const options = { modulePath: "", tmp: "/tmp/spec", env, fixtureDirectory: directory };
    const collect = (fd: number, bytes: Uint8Array) => {
      const output = fd === 2 ? stderr : stdout;
      output.push(Buffer.from(bytes));
    };
    const status = await runRoot(runtime, api, shell, options, script, collect, (terminate) => {
      stop = terminate;
    });
    return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }
  return { execute, loads, installations, runtime };
}

for (const expected of loadSortUniqObservations()) {
  test(`ordinary WASI ${expected.name} matches frozen GNU`, { timeout: 15000 }, async (context) => {
    const state = await fixture(context);
    const actual = await state.execute(expected.script);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.stdout, Buffer.from(expected.stdout));
    assert.equal(actual.stderr.length > 0, expected.stderrPresent);
  });
}

test(
  "sort and uniq load on separate first spawns and dispose independently",
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    assert.deepEqual(state.loads, { sort: 0, uniq: 0 });
    assert.equal((await state.execute("printf 'b\\na' | sort")).stdout.toString(), "a\nb\n");
    assert.deepEqual(state.loads, { sort: 1, uniq: 0 });
    await state.installations.get("sort")?.dispose();
    assert.equal((await state.execute("sort")).status, 127);
    assert.equal((await state.execute("printf 'a\\na' | uniq")).stdout.toString(), "a\n");
    assert.deepEqual(state.loads, { sort: 1, uniq: 1 });
    await state.installations.get("uniq")?.dispose();
    assert.equal((await state.execute("uniq")).status, 127);
    assert.equal(state.runtime.disposed, false);
  },
);
