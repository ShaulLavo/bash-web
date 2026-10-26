import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";

const nodeDirectory = new URL("../.build/node/", import.meta.url);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const wc = new Uint8Array(await readFile(resolve(directory, "wc.wasm")));
const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", LC_ALL: "C" };

interface RunOptions {
  installed?: boolean;
  interrupt?: boolean;
}

async function run(context: TestContext, script: string, options: RunOptions = {}) {
  const admitted = Promise.withResolvers<number>();
  installNodeWorkers();
  const runtime = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
    onProcessAdmission(event) {
      if (event.stage === "launched") admitted.resolve(event.pid);
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stop = () => {};
  context.after(async () => {
    stop();
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  });
  for (const path of ["/tmp/spec", "/bin", "/home/user"]) await runtime.filesystem.mkdirp(path);
  if (options.installed !== false)
    await api.installWc(runtime, { workerUrl: new URL("shell.mjs", nodeDirectory), source: wc });
  await runtime.filesystem.drain();
  const completion = runRoot(
    runtime,
    api,
    shell,
    { modulePath: "", tmp: "/tmp/spec", env, fixtureDirectory: directory },
    script,
    (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
    (terminate) => {
      stop = terminate;
    },
  );
  if (options.interrupt) {
    const pid = await admitted.promise;
    await setTimeout(25);
    const service = await runtime.processes();
    await service.kill(pid, 2);
  }
  const status = await completion;
  return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

const cases = [
  ["default stdin counts", "printf 'one two\\nthree\\n' | wc", "      2       3      14\n", 0],
  ["line selection", "printf 'one two\\nthree\\n' | wc -l", "2\n", 0],
  ["word selection", "printf 'one two\\nthree\\n' | wc -w", "3\n", 0],
  ["byte selection", "printf 'one two\\nthree\\n' | wc -c", "14\n", 0],
  ["binary byte selection", "printf '\\377\\000a b\\n' | wc -c", "6\n", 0],
  ["external pipeline input", "printf 'one two\\nthree\\n' | cat | wc -c", "14\n", 0],
  [
    "file operands and total",
    "printf 'a b\\n' > one; printf 'x\\ny z\\n' > two; wc one two",
    " 1  2  4 one\n 2  3  6 two\n 3  5 10 total\n",
    0,
  ],
  [
    "relative file uses the process directory",
    "mkdir nested; printf 'one two\\n' > nested/input; cd nested; wc input",
    "1 2 8 input\n",
    0,
  ],
] as const;

for (const [name, script, stdout, status] of cases) {
  test(`wc produces exact output for ${name}`, { timeout: 10000 }, async (context) => {
    const actual = await run(context, script);
    assert.equal(actual.status, status);
    assert.equal(actual.stdout.toString("latin1"), stdout);
    assert.equal(actual.stderr.length, 0);
  });
}

test("wc stays absent until installed", { timeout: 10000 }, async (context) => {
  const actual = await run(context, "wc", { installed: false });
  assert.equal(actual.status, 127);
  assert.equal(actual.stdout.length, 0);
});

test("wc reports a missing file and returns status 1", { timeout: 10000 }, async (context) => {
  const actual = await run(context, "wc missing");
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout.length, 0);
  assert.match(actual.stderr.toString(), /missing/);
});

test("wc rejects an invalid option with status 2", { timeout: 10000 }, async (context) => {
  const actual = await run(context, "wc --not-an-option");
  assert.equal(actual.status, 2);
  assert.equal(actual.stdout.length, 0);
  assert.match(actual.stderr.toString(), /--not-an-option/);
});

test("wc stops when its downstream closes the pipe", { timeout: 15000 }, async (context) => {
  const name = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
  const script = `name=${name}; : > "$name"; printf -v files "$name %.0s" {1..1000}; set -o pipefail; wc $files | { IFS= read -r first; printf '%s\\n' "$first"; }; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`;
  const actual = await run(context, script);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), `0 0 0 ${name}\nSTATUS:1:1 0\n`);
  assert.match(actual.stderr.toString(), /broken pipe/i);
});

test(
  "ordinary wc is interruptible while its producer stays open",
  { timeout: 10000 },
  async (context) => {
    const actual = await run(context, "while printf x; do :; done | wc", { interrupt: true });
    assert.equal(actual.status, 130);
    assert.equal(actual.stdout.length, 0);
  },
);
