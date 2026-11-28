import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempDisposableSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import usageCases from "../../shell/compat-fixtures/tests/grep-usage-cases.json" with { type: "json" };
import { familyWasmPath } from "../build/family-assets.ts";
import { liveNodeWorkers, stopNodeWorkers } from "../build/node-worker-host.ts";
import { createWaffleRunner } from "../waffle-compat.ts";
import { api, directory, nodeDirectory, waffleFixture } from "./own-shell-waffle-fixture.ts";

const modulePath = resolve(directory, "shell-runtime.wasm");
const grepPath = resolve(directory, "freebsd-grep.wasm");
const scratch = mkdtempDisposableSync(
  resolve(
    process.env.RUNNER_TEMP ??
      process.env.TMPDIR ??
      (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
    "bash-web-freebsd-grep-replay-",
  ),
);
function removeScratchOnSignal(signal: NodeJS.Signals) {
  try {
    scratch.remove();
  } finally {
    process.kill(process.pid, signal);
  }
}

process.once("exit", scratch.remove);
process.once("SIGINT", removeScratchOnSignal);
process.once("SIGTERM", removeScratchOnSignal);
after(async () => {
  try {
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  } finally {
    scratch.remove();
    process.removeListener("exit", scratch.remove);
    process.removeListener("SIGINT", removeScratchOnSignal);
    process.removeListener("SIGTERM", removeScratchOnSignal);
  }
});

const helpers = ["cat", "seq", "wc"];
const env = { PATH: "/usr/bin:/bin", HOME: "/", LC_ALL: "C", LANG: "C" };
const runner = await createWaffleRunner({
  modulePath,
  fixtureDirectory: directory,
  utilityDirectory: scratch.path,
  programs: ["grep", "seq", "wc"],
  env,
  tmp: "/grep-tests",
});

before(() => {
  copyFileSync(grepPath, resolve(scratch.path, "grep.wasm"));
  for (const name of helpers)
    copyFileSync(familyWasmPath(name), resolve(scratch.path, `${name}.wasm`));
});

const timeout = { timeout: 30_000 };

async function run(context: TestContext, script: string) {
  const stop = () => void stopNodeWorkers();
  context.signal.addEventListener("abort", stop, { once: true });
  try {
    const result = await runner(script);
    assert.equal(result.crash, undefined, script);
    assert.equal(result.outputLimit, undefined, script);
    assert.equal(liveNodeWorkers(), 0);
    return result;
  } finally {
    context.signal.removeEventListener("abort", stop);
  }
}

test("the installed grep identifies itself as FreeBSD grep", timeout, async (context) => {
  const result = await run(context, "grep --version");
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.toString(), "");
  assert.match(result.stdout.toString(), /^grep \(BSD grep, GNU compatible\) [^\n]+-FreeBSD\n$/);
});

for (const { name, script, status, stdout, stderrPresent } of usageCases) {
  test(`FreeBSD grep usage: ${name}`, timeout, async (context) => {
    const result = await run(context, script);
    assert.equal(result.status, status, result.stderr.toString());
    assert.equal(result.stdout.toString(), stdout);
    assert.equal(result.stderr.length > 0, stderrPresent, result.stderr.toString());
  });
}

const options = [
  ["printf 'ab\\nabab\\na+b\\n' | grep -Ec '^(ab)+$'", 0, "2\n"],
  ["printf 'a+b\\naaab\\n' | grep 'a+b'", 0, "a+b\n"],
  ["printf 'ab\\nabab\\na+b\\n' | grep -c '^\\(ab\\)\\+$'", 0, "2\n"],
  ["printf 'tick\\nmiss\\n' | grep -vqc tick", 0, ""],
  ["printf 'abc\\ndef\\n' | grep 'x\ndef'", 0, "def\n"],
  ["printf 'x\\r\\n' | grep 'x$'", 1, ""],
  ["printf '\\n' | grep -n ''", 0, "1:\n"],
  ["printf '' | grep -c ''", 1, "0\n"],
  ["printf -- '-needle\\n' | grep -- -needle", 0, "-needle\n"],
  ["printf 'aaab\\na+b\\n' | grep -EF 'a+b'", 0, "a+b\n"],
  ["printf 'aaab\\na+b\\n' | grep -FE 'a+b'", 0, "aaab\n"],
  ["printf '12345' | grep .", 0, "12345\n"],
  [
    "printf 'a\\nx\\na' >first; printf 'y\\na\\n' >second; grep -nc a first second",
    0,
    "first:2\nsecond:1\n",
  ],
] as const;

async function output(context: TestContext, script: string, status: number, stdout: string) {
  const result = await run(context, script);
  assert.equal(result.status, status, result.stderr.toString());
  assert.equal(result.stderr.toString(), "");
  assert.equal(result.stdout.toString(), stdout);
}

for (const [script, status, stdout] of options) {
  test(`FreeBSD grep options: ${script}`, timeout, (context) =>
    output(context, script, status, stdout),
  );
}

for (const [script, stderr] of [
  ["grep", /^usage: grep /],
  ["grep -Z x", /^grep: unrecognized option: Z\nusage: grep /],
  ["printf 'a\\n' | grep -E 'a{1000000}'", /^grep: Invalid contents of \{\}\n$/],
] as const) {
  test(`FreeBSD grep diagnostic: ${script}`, timeout, async (context) => {
    const result = await run(context, script);
    assert.equal(result.status, 2, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    assert.match(result.stderr.toString(), stderr);
  });
}

test(
  "FreeBSD grep accepts basic patterns beyond the legacy byte budget",
  timeout,
  async (context) => {
    const long = "x".repeat(4097);
    const first = "a".repeat(2048);
    const second = "b".repeat(2048);
    await output(context, `printf '%s\\n' '${long}' | grep '${long}'`, 0, `${long}\n`);
    await output(
      context,
      `printf '%s\\n' '${second}' | grep -e '${first}' -e '${second}'`,
      0,
      `${second}\n`,
    );
  },
);

test(
  "FreeBSD grep reports binary matches by default and preserves exact bytes with -a",
  timeout,
  async (context) => {
    const setup = "printf 'x\\000\\377\\r\\nother' >bytes";
    await output(context, `${setup}; grep -Fn x bytes`, 0, "Binary file bytes matches\n");
    const result = await run(context, `${setup}; grep -aFn x bytes`);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr.toString(), "");
    assert.deepEqual(result.stdout, Buffer.from([49, 58, 120, 0, 255, 13, 10]));
  },
);

const lines = "printf 'a^b\\na$b\\na\\n^a\\na$\\n^^a\\na$$\\nab\\nb\\n^b\\n' >lines";
for (const [pattern, stdout] of [
  ["a^b", "1:a^b\n"],
  ["a$b", "2:a$b\n"],
  ["^^a", "4:^a\n"],
  ["a$$", "5:a$\n"],
  [String.raw`a\^b`, "1:a^b\n"],
  [String.raw`a\$b`, "2:a$b\n"],
  [String.raw`\(^a$\)`, "3:a\n"],
  [String.raw`\(^a$\)\|\(^b$\)`, "3:a\n9:b\n"],
  [String.raw`z\|^b`, "9:b\n"],
  [String.raw`a$\|z`, "3:a\n4:^a\n6:^^a\n"],
  [String.raw`z\|^^b`, "10:^b\n"],
  [String.raw`\(^\^a\)`, "4:^a\n"],
  [String.raw`\(a$\)b`, ""],
  [String.raw`a\(^b\)`, ""],
  ["(^a", ""],
  ["z|^b", ""],
  ["a$)", ""],
] as const) {
  test(`FreeBSD grep basic anchors: ${pattern}`, timeout, (context) =>
    output(context, `${lines}; grep -n '${pattern}' <lines`, stdout ? 0 : 1, stdout),
  );
}

test("extended and fixed matching give anchors their own meaning", timeout, async (context) => {
  await output(context, `${lines}; grep -nE 'a^b' lines`, 1, "");
  await output(context, `${lines}; grep -nF 'a$b' lines`, 0, "2:a$b\n");
});

for (const path of ["/dev/fd/4", "/proc/self/fd/4", "/dev//fd/4"]) {
  test(`FreeBSD grep reopens remapped ${path} without advancing the original`, timeout, (context) =>
    output(
      context,
      `printf 'one\\ntwo\\n' >file; printf 'other\\n' >other; exec 3<file; exec 4<&3; exec 3<other; IFS= read -r first <&4; grep one ${path}; IFS= read -r next <&4; printf '%s:%s\\n' "$first" "$next"`,
      0,
      "one\none:two\n",
    ),
  );
}

for (const [setup, path] of [
  ["", "/dev/fd/4"],
  ["", "/proc/self/fd/5"],
  ["exec 3<&-; ", "/dev/fd/3"],
] as const) {
  test(
    `FreeBSD grep quiet success takes priority over a closed ${path}`,
    timeout,
    async (context) => {
      const result = await run(context, `${setup}printf 'hit\\n' >file; grep -q hit ${path} file`);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(result.stdout.toString(), "");
      assert.ok(result.stderr.toString().includes(path), result.stderr.toString());
    },
  );
}

test(
  "an unopened FreeBSD grep descriptor cannot fall back to piped stdin",
  timeout,
  async (context) => {
    const result = await run(context, "printf secret | grep secret /dev/fd/6");
    assert.equal(result.status, 2, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    assert.match(result.stderr.toString(), /^grep: \/dev\/fd\/6:/);
  },
);

test("FreeBSD grep forwards more than one MiB through both pipes", timeout, async (context) => {
  const result = await run(context, "set -o pipefail; seq 1 400000 | grep -E '^[0-9]+$' | wc -lc");
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.toString(), "");
  assert.match(result.stdout.toString(), /^ *400000 +2688895\n$/);
});

test("FreeBSD grep reports its own status when a downstream reader closes", timeout, (context) =>
  output(
    context,
    `set -o pipefail; seq 1 400000 | grep . | { IFS= read -r first; printf '%s\\n' "$first"; }; printf '%s:%s\\n' "$?" "\${PIPESTATUS[1]}"`,
    0,
    "1\n141:141\n",
  ),
);

const shellWasmUrl = `data:application/wasm;base64,${(await readFile(modulePath)).toString("base64")}`;

async function liveShell(context: TestContext) {
  const fixture = await waffleFixture(context);
  const { runtime } = fixture;
  await api.installPrograms(
    runtime,
    [
      {
        name: "grep-tests",
        programs: ["grep", "cat", "seq"].map((name) => ({
          path: `/bin/${name}`,
          source: () => readFile(resolve(scratch.path, `${name}.wasm`)),
        })),
      },
    ],
    { launcher: api.genericProgramLauncher(new URL("preview1.mjs", nodeDirectory)) },
  );
  const shell = await api.createShell({
    runtime,
    env,
    wasmUrl: shellWasmUrl,
    workerUrl: new URL("shell.mjs", nodeDirectory),
    signal: context.signal,
  });
  fixture.setStop(() => shell.interrupt());
  context.after(() => shell.dispose());
  const supervisor = await (await runtime.processes()).ready();
  const initial = await shell.waitForPrompt({ signal: context.signal });
  const decoder = new TextDecoder();
  let captured = "";
  const output = () => {
    captured += decoder.decode(shell.terminal.drain(), { stream: true });
    return captured;
  };
  const descendants = () =>
    Array.from(supervisor.table.values()).filter(
      (record) => record.rootPid === shell.process.pid && record.pid !== shell.process.pid,
    );
  const until = async (ready: () => boolean) => {
    while (!ready()) await delay(2, undefined, { signal: context.signal });
  };
  return {
    shell,
    initial,
    output,
    async send(input: string) {
      const bytes = Buffer.from(`${input}\r`);
      let offset = 0;
      await until(() => {
        offset += shell.terminal.send(bytes.subarray(offset));
        return offset === bytes.length;
      });
    },
    running(path: string) {
      return descendants().some(
        (record) => record.image.request?.executable === path && record.state === "running",
      );
    },
    until,
    async prompt(after: bigint, status: number) {
      const receipt = await shell.waitForPrompt({ after, signal: context.signal });
      assert.deepEqual(receipt, { generation: after + 1n, status }, output());
      assert.equal(descendants().filter((record) => !record.result).length, 0, output());
      return receipt;
    },
  };
}

test(
  "line-buffered FreeBSD grep sends successive matches before its producer closes",
  timeout,
  async (context) => {
    const f = await liveShell(context);
    await f.send(
      "{ printf 'tick 0\\n'; IFS= read -r gate; printf 'tick 1\\n'; IFS= read -r gate; } | grep --line-buffered tick | cat",
    );
    await f.until(() => f.output().includes("tick 0\n"));
    assert.equal(f.shell.terminal.readPrompt()?.generation, f.initial.generation);
    await f.send("next");
    await f.until(() => f.output().includes("tick 1\n"));
    assert.equal(f.shell.terminal.readPrompt()?.generation, f.initial.generation);
    assert.ok(f.running("/bin/grep"));
    f.shell.interrupt();
    await f.prompt(f.initial.generation, 130);
  },
);

test(
  "interrupting a parked unmatched grep pipeline preserves the shell session",
  timeout,
  async (context) => {
    const f = await liveShell(context);
    await f.send(
      "secret=kept; { printf 'tick\\n'; printf 'PRODUCER_READY\\n' >&2; IFS= read -r gate; } | cat | grep unmatched; printf 'BAD_AFTER_INTERRUPT\\n'",
    );
    await f.until(
      () =>
        f.output().includes("PRODUCER_READY\n") && f.running("/bin/grep") && f.running("/bin/cat"),
    );
    assert.equal(f.shell.terminal.readPrompt()?.generation, f.initial.generation);
    f.shell.interrupt();
    const interrupted = await f.prompt(f.initial.generation, 130);
    await f.send(`printf '%s:%s\\n' "$secret" "$?"`);
    await f.prompt(interrupted.generation, 0);
    await f.until(() => f.output().includes("kept:130\n"));
    assert.ok(!f.output().includes("BAD_AFTER_INTERRUPT\n"), f.output());
    assert.ok(!f.output().includes("tick\n"), f.output());
  },
);

test(
  "interrupting FreeBSD grep stops an always-ready unmatched pipeline",
  timeout,
  async (context) => {
    const f = await liveShell(context);
    await f.send(
      "seq 1 1000000000000 | { IFS= read -r first; printf 'SOURCE %s\\n' \"$first\" >&2; cat; } | grep unmatched",
    );
    await f.until(() => f.output().includes("SOURCE 1\n") && f.running("/bin/grep"));
    assert.equal(f.shell.terminal.readPrompt()?.generation, f.initial.generation);
    f.shell.interrupt();
    await f.prompt(f.initial.generation, 130);
  },
);

test("quiet FreeBSD grep closes its reader before producer EOF", timeout, async (context) => {
  const f = await liveShell(context);
  await f.send(
    "{ IFS= read -r gate; printf 'quiet payload\\n'; IFS= read -r gate; while :; do printf '%4096s\\n' tick; done; } | grep -q quiet",
  );
  await f.until(() => f.running("/bin/grep"));
  await f.send("match");
  await f.until(() => !f.running("/bin/grep"));
  assert.equal(f.shell.terminal.readPrompt()?.generation, f.initial.generation);
  await f.send("write");
  const done = await f.prompt(f.initial.generation, 0);
  await f.send(`printf '%s:%s\\n' "\${PIPESTATUS[0]}" "\${PIPESTATUS[1]}"`);
  await f.prompt(done.generation, 0);
  await f.until(() => f.output().includes("141:0\n"));
  assert.ok(!f.output().includes("quiet payload\n"), f.output());
});
