import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { api, directory, nodeDirectory, waffleFixture } from "./own-shell-waffle-fixture.ts";
import { familyWasmPath } from "./family-assets.ts";

const bytes = await readFile(`${directory}/shell-runtime.wasm`);
const wasmUrl = `data:application/wasm;base64,${bytes.toString("base64")}`;
const encoder = new TextEncoder();

async function fixture(context: TestContext, script?: string) {
  const { runtime } = await waffleFixture(context);
  const shell = await api.createShell({
    runtime,
    wasmUrl,
    workerUrl: new URL("shell.mjs", nodeDirectory),
    script,
  });
  context.after(() => shell.dispose());
  return { runtime, shell };
}

async function send(
  shell: Awaited<ReturnType<typeof api.createShell>>,
  source: string,
  signal?: AbortSignal,
) {
  const abort = () => shell.terminal.signal();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await sendBytes(shell, encoder.encode(source + "\r"), signal);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
async function sendBytes(
  shell: Awaited<ReturnType<typeof api.createShell>>,
  input: Uint8Array,
  signal?: AbortSignal,
) {
  let offset = 0;
  while (offset < input.length) {
    const wake = Atomics.load(shell.terminal.state, api.control.wake);
    signal?.throwIfAborted();
    offset += shell.terminal.send(input.subarray(offset));
    if (offset < input.length)
      await Atomics.waitAsync(shell.terminal.state, api.control.wake, wake).value;
  }
}

test(
  "public prompt API waits for guest startup, commands, interrupts and disposal",
  { timeout: 30000 },
  async (context) => {
    const { runtime, shell } = await fixture(context);
    const drain = setInterval(() => shell.terminal.drain(), 1);
    context.after(() => clearInterval(drain));
    let receipt = await shell.waitForPrompt();
    assert.deepEqual(receipt, { generation: 1n, status: 0 });
    const submit = async (source: string, status: number) => {
      const after = receipt.generation;
      await send(shell, source);
      receipt = await shell.waitForPrompt({ after });
      assert.deepEqual(receipt, { generation: after + 1n, status });
      assert.deepEqual(await shell.waitForPrompt({ after }), receipt);
    };
    await submit("false", 1);
    await submit("true", 0);
    await submit("cd /missing", 1);
    await submit("if ;", 2);
    await submit("echo $((1/0))", 1);
    await submit("missing-command", 127);
    await submit("fail() { return 7; }; fail", 7);
    await submit("false | true", 0);
    await submit("true | false", 1);
    await submit("false &", 0);
    await submit("wait", 0);
    await api.installPrograms(
      runtime,
      [
        {
          name: "prompt-cat",
          programs: [{ path: "/bin/cat", source: () => readFile(familyWasmPath("cat")) }],
        },
      ],
      { launcher: api.genericProgramLauncher(new URL("preview1.mjs", nodeDirectory)) },
    );
    await submit("printf data >value; cat value", 0);
    await submit("cat /missing", 1);
    await submit("true", 0);
    await send(shell, "cat");
    while (!shell.diagnostics().roots.some((root) => root.liveProcesses > 1))
      await new Promise((resolve) => setTimeout(resolve, 1));
    const foreground = receipt.generation;
    shell.interrupt();
    receipt = await shell.waitForPrompt({ after: foreground });
    assert.deepEqual(receipt, { generation: foreground + 1n, status: 130 });
    const after = receipt.generation;
    shell.interrupt();
    receipt = await shell.waitForPrompt({ after });
    assert.deepEqual(receipt, { generation: after + 1n, status: 130 });
    await submit("", 130);
    await submit("true", 0);
    const pending = shell.waitForPrompt({ after: receipt.generation });
    const rejected = assert.rejects(pending, /Shell closed/);
    await shell.dispose();
    await rejected;
    await assert.rejects(shell.waitForPrompt(), /Shell closed/);
  },
);

test(
  "public prompt wait rejects when a script exits without any prompt",
  { timeout: 15000 },
  async (context) => {
    const { shell } = await fixture(context, "exit 23");
    await assert.rejects(shell.waitForPrompt(), /Shell closed/);
    assert.equal((await shell.done).code, 23);
  },
);

test("runtime disposal rejects the public prompt wait", { timeout: 15000 }, async (context) => {
  const { runtime, shell } = await fixture(context);
  const prompt = await shell.waitForPrompt();
  const rejected = assert.rejects(
    shell.waitForPrompt({ after: prompt.generation }),
    /Shell closed/,
  );
  await runtime.dispose();
  await rejected;
  await assert.rejects(shell.waitForPrompt(), /Shell closed/);
});

async function until(context: TestContext, ready: () => boolean) {
  while (!ready()) {
    context.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function signalFixture(
  context: TestContext,
  mode: Parameters<typeof api.signalStatusGuest>[0],
  status = 0,
) {
  const { runtime, shell } = await fixture(context);
  const decoder = new TextDecoder();
  let captured = "";
  const output = () => {
    captured += decoder.decode(shell.terminal.drain(), { stream: true });
    return captured;
  };
  const drain = setInterval(output, 1);
  context.after(() => clearInterval(drain));
  const initial = await shell.waitForPrompt({ signal: context.signal });
  await api.installPrograms(
    runtime,
    [
      {
        name: "signal-status",
        programs: [
          {
            path: "/bin/signal-status",
            source: async () => api.signalStatusGuest(mode, status),
          },
        ],
      },
    ],
    { launcher: api.guestLauncher(runtime, new URL("shell.mjs", nodeDirectory).href) },
  );
  const ready = () => until(context, () => output().includes("SIGNAL_READY\n"));
  return { runtime, shell, initial, output, ready };
}

for (const { mode, status, source, expected, after } of [
  { mode: "handled", status: 0, source: "signal-status", expected: 0, after: false },
  { mode: "handled", status: 7, source: "signal-status", expected: 7, after: false },
  { mode: "handled", status: 130, source: "signal-status; printf AFTER", expected: 0, after: true },
  {
    mode: "default",
    status: 0,
    source: "signal-status; printf AFTER",
    expected: 130,
    after: false,
  },
  { mode: "removed", status: 0, source: "signal-status", expected: 130, after: false },
  { mode: "once", status: 0, source: "signal-status", expected: 130, after: false },
  { mode: "handled", status: 0, source: "signal-status; printf AFTER", expected: 0, after: true },
  {
    mode: "default",
    status: 0,
    source: "while :; do signal-status; done",
    expected: 130,
    after: false,
  },
  {
    mode: "handled",
    status: 0,
    source: "( signal-status ); printf AFTER",
    expected: 0,
    after: true,
  },
  { mode: "handled", status: 0, source: "f() { signal-status; }; f", expected: 0, after: false },
  { mode: "handled", status: 0, source: "x=$(signal-status 1>&2)", expected: 130, after: false },
  {
    mode: "handled",
    status: 0,
    source: "while :; do :; done | signal-status",
    expected: 130,
    after: false,
  },
  {
    mode: "handled",
    status: 0,
    source: "signal-status 1>&2 | while :; do :; done",
    expected: 130,
    after: false,
  },
  {
    mode: "handled",
    status: 0,
    source: "signal-status 1>&2 | signal-status",
    expected: 0,
    after: false,
  },
] as const) {
  test(`public prompt SIGINT ${mode}/${status}: ${source}`, { timeout: 15000 }, async (context) => {
    const { shell, initial, output, ready } = await signalFixture(context, mode, status);
    let shellDone:
      | { kind: "pending" }
      | { kind: "settled"; value: Awaited<typeof shell.done> }
      | { kind: "rejected"; error: string } = { kind: "pending" };
    void shell.done.then(
      (value) => {
        shellDone = { kind: "settled", value };
      },
      (error: unknown) => {
        shellDone = { kind: "rejected", error: String(error) };
      },
    );
    context.after(() => context.diagnostic(output()));
    await send(shell, source);
    await ready();
    if (source === "signal-status 1>&2 | signal-status")
      await until(context, () => output().split("SIGNAL_READY\n").length > 2);
    shell.interrupt();
    const prompt = await shell
      .waitForPrompt({ after: initial.generation, signal: context.signal })
      .catch((error: unknown) => {
        context.diagnostic(
          JSON.stringify(
            {
              shellDone,
              phase: Atomics.load(shell.terminal.state, api.control.phase),
              status: Atomics.load(shell.terminal.state, api.control.status),
              closed: shell.terminal.closed(),
              prompt: shell.terminal.readPrompt(),
            },
            (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
          ),
        );
        throw error;
      });
    assert.equal(prompt.status, expected, output());
    assert.equal(output().includes("AFTER\x1b[?2004h"), after, output());
    if (mode === "handled") assert.ok(output().includes("SIGNAL_HANDLED 1\n"), output());
  });
}

for (const { source, expected } of [
  { source: "signal-status", expected: 12 },
  { source: "signal-status 1>&2 | while :; do :; done", expected: 130 },
]) {
  test(
    `second Ctrl-C reaches a continuing guest: ${source}`,
    { timeout: 10000 },
    async (context) => {
      const { shell, initial, output, ready } = await signalFixture(context, "continue");
      await send(shell, source);
      await ready();
      shell.interrupt();
      await until(context, () => output().includes("SIGNAL_HANDLED 1\n"));
      assert.equal(shell.terminal.readPrompt()?.generation, initial.generation);
      shell.interrupt();
      const prompt = await shell.waitForPrompt({
        after: initial.generation,
        signal: context.signal,
      });
      assert.equal(prompt.status, expected, output());
      assert.equal(output().split("SIGNAL_HANDLED 1\n").length - 1, 1);
      assert.equal(output().split("SIGNAL_HANDLED 2\n").length - 1, 1);
    },
  );
}

test(
  "disposing a continuing foreground guest rejects its prompt wait",
  { timeout: 5000 },
  async (context) => {
    const { shell, initial, ready } = await signalFixture(context, "continue");
    await send(shell, "signal-status");
    await ready();
    const rejected = assert.rejects(
      shell.waitForPrompt({ after: initial.generation }),
      /Shell closed/,
    );
    await shell.dispose();
    await rejected;
  },
);

for (const typeahead of [false, true]) {
  test(
    `handled foreground reader resumes after Ctrl-C, typeahead=${typeahead}`,
    { timeout: 5000 },
    async (context) => {
      const { shell, initial, output, ready } = await signalFixture(context, "reader");
      await send(shell, "signal-status");
      await ready();
      if (typeahead) await sendBytes(shell, encoder.encode("s"), context.signal);
      shell.interrupt();
      await until(context, () => output().includes("SIGNAL_HANDLED 1\n"));
      await sendBytes(shell, encoder.encode("x"), context.signal);
      const prompt = await shell.waitForPrompt({
        after: initial.generation,
        signal: context.signal,
      });
      assert.deepEqual(prompt, { generation: initial.generation + 1n, status: 0 }, output());
      assert.ok(output().includes("READER_INPUT x\n"), output());
      assert.ok(!output().includes("READER_INPUT s\n"), output());
    },
  );
}

for (const mode of ["handled", "exit"] as const) {
  test(
    `external ${mode} preserves cooked input for a following shell read`,
    { timeout: 5000 },
    async (context) => {
      const { shell, initial, output, ready } = await signalFixture(context, mode);
      await send(shell, 'signal-status; read x; printf "[%s]" "$x"');
      await ready();
      if (mode === "handled") {
        shell.interrupt();
        await until(context, () => output().includes("SIGNAL_HANDLED 1\n"));
      }
      await send(shell, "y", context.signal);
      const prompt = await shell.waitForPrompt({
        after: initial.generation,
        signal: context.signal,
      });
      assert.equal(prompt.status, 0, output());
      assert.ok(output().includes("[y]"), output());
    },
  );
}

for (let run = 0; run < 6; run++) {
  test(
    `delegated pipeline keeps its reader after a handled sibling exits: ${run}`,
    { timeout: 5000 },
    async (context) => {
      const { runtime, shell, initial, output } = await signalFixture(context, "handled", 7);
      await api.installPrograms(
        runtime,
        [
          {
            name: "reader",
            programs: [
              { path: "/bin/reader", source: async () => api.signalStatusGuest("reader") },
            ],
          },
        ],
        { launcher: api.guestLauncher(runtime, new URL("shell.mjs", nodeDirectory).href) },
      );
      context.after(() => context.diagnostic(output()));
      await send(shell, "{ signal-status 1>&2 | reader 0<&3; } 3<&0");
      await until(context, () => output().split("SIGNAL_READY\n").length === 3);
      shell.interrupt();
      await until(context, () => output().split("SIGNAL_HANDLED 1\n").length === 3);
      await sendBytes(shell, encoder.encode("x"), context.signal);
      const receipt = await shell.waitForPrompt({
        after: initial.generation,
        signal: context.signal,
      });
      assert.deepEqual(receipt, { generation: initial.generation + 1n, status: 0 }, output());
      assert.ok(output().includes("READER_INPUT x\n"), output());
    },
  );
}
