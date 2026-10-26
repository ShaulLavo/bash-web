import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";

const nodeDirectory = new URL("../.build/node/", import.meta.url);
const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const xargs = new Uint8Array(await readFile(resolve(directory, "xargs.wasm")));

async function fixture(context: TestContext) {
  let stop = () => {};
  let loads = 0;
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
  for (const path of ["/tmp/spec", "/bin"]) await runtime.filesystem.mkdirp(path);
  const installation = await api.installXargs(runtime, {
    workerUrl: new URL("shell.mjs", nodeDirectory),
    source() {
      loads++;
      return xargs;
    },
  });
  await runtime.filesystem.drain();
  async function execute(script: string) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const options = {
      modulePath: "",
      tmp: "/tmp/spec",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      fixtureDirectory: directory,
    };
    const status = await runRoot(
      runtime,
      api,
      shell,
      options,
      script,
      (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
      (terminate) => {
        stop = terminate;
      },
    );
    return {
      status,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  }
  return { execute, installation, runtime, loads: () => loads };
}

// Literal acceptance controls, not recorded GNU observations. Never invoke a host oracle.
const cases = [
  ["default whitespace", "printf 'a b\\nc' | xargs", "a b c\n"],
  ["quotes and escapes", "printf '%s\\n' '\"two words\" a\\ b' | xargs -n1", "two words\na b\n"],
  ["NUL records", "printf 'a b\\0c\\nd\\0' | xargs -0 -n1", "a b\nc\nd\n"],
  ["custom delimiter", "printf 'a b:c:d' | xargs -d: -n2", "a b c\nd\n"],
  ["line batches", "printf 'a b\\nc d\\n' | xargs -L1", "a b\nc d\n"],
  ["size batches", "printf 'a b c' | xargs -s9", "a b\nc\n"],
  ["empty input", "printf '' | xargs", "\n"],
  ["skip empty", "printf ' \\t\\n' | xargs -r", ""],
  ["EOF marker", "printf 'a STOP b' | xargs -E STOP", "a\n"],
  ["relative input file", "printf 'a b c' > args; xargs -a args -n2", "a b\nc\n"],
] as const;

for (const [label, script, expected] of cases) {
  test(`xargs ${label} in Waffle`, { timeout: 10000 }, async (context) => {
    const state = await fixture(context);
    const result = await state.execute(script);
    assert.deepEqual(result, { status: 0, stdout: expected, stderr: "" });
  });
}

test(
  "xargs loads once on first use and releases only its own registration",
  { timeout: 10000 },
  async (context) => {
    const state = await fixture(context);
    assert.equal(state.loads(), 0);
    assert.equal((await state.execute("printf a | xargs")).stdout, "a\n");
    assert.equal((await state.execute("printf b | xargs")).stdout, "b\n");
    assert.equal(state.loads(), 1);
    await state.installation.dispose();
    assert.equal((await state.execute("xargs")).status, 127);
    assert.equal(await state.runtime.filesystem.lookup("/bin/xargs"), undefined);
    assert.equal(state.runtime.disposed, false);
  },
);

for (const command of [
  "xargs echo",
  "xargs -r echo",
  "xargs -- /bin/echo",
  "xargs -a missing echo",
]) {
  test(`xargs gates ${command}`, { timeout: 10000 }, async (context) => {
    const state = await fixture(context);
    const result = await state.execute(command);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /runtime_proc.spawn\/wait/);
    assert.doesNotMatch(result.stderr, /Failed to open/);
  });
}

test(
  "xargs rejects parallel and replacement modes and malformed input",
  { timeout: 10000 },
  async (context) => {
    const state = await fixture(context);
    for (const script of ["xargs -P2", "xargs -I{}", "printf '%s' '\"unterminated' | xargs"]) {
      const result = await state.execute(script);
      assert.equal(result.status, 1, script);
      assert.equal(result.stdout, "", script);
      assert.notEqual(result.stderr, "", script);
    }
  },
);
