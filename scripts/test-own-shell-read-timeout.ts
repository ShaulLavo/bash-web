import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { api, directory, nodeDirectory, waffleFixture } from "./own-shell-waffle-fixture.ts";
import { releaseShellRunner } from "./release-shell-runner.ts";
import fixture from "./fixtures/shell-read-timeout.json" with { type: "json" };

assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const run = await releaseShellRunner(fixture.env);
for (const item of fixture.cases)
  test(`production Waffle read timeout ${item.id}`, async () => {
    const actual = await run(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from(item.stdoutBase64, "base64"), item.script);
  });

const bytes = await readFile(`${directory}/shell-runtime.wasm`);
const wasmUrl = `data:application/wasm;base64,${bytes.toString("base64")}`;
const encoder = new TextEncoder();

async function interactive(context: TestContext) {
  const { runtime } = await waffleFixture(context);
  const shell = await api.createShell({
    runtime,
    wasmUrl,
    workerUrl: new URL("shell.mjs", nodeDirectory),
  });
  let output = "";
  const decoder = new TextDecoder();
  const drain = () => {
    output += decoder.decode(shell.terminal.drain(), { stream: true });
    return output;
  };
  const interval = setInterval(drain, 1);
  context.after(async () => {
    clearInterval(interval);
    await shell.dispose();
  });
  const initial = await shell.waitForPrompt({ signal: context.signal });
  const send = (source: string) => sendInput(shell, encoder.encode(source + "\r"), context.signal);

  return { runtime, shell, initial, send, output: drain };
}

async function sendInput(
  shell: Awaited<ReturnType<typeof api.createShell>>,
  input: Uint8Array,
  signal: AbortSignal,
) {
  let offset = 0;
  while (offset < input.length) {
    signal.throwIfAborted();
    offset += shell.terminal.send(input.subarray(offset));
    if (offset < input.length) await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function until(context: TestContext, ready: () => boolean) {
  while (!ready()) {
    context.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

for (const source of [
  'read -t0.3 x; printf \'\\nIDLE:%s[%s]\\n\' "$?" "$x"',
  'TMOUT=0.3; read x; printf \'\\nIDLE:%s[%s]\\n\' "$?" "$x"',
])
  test(
    `production matching-wake timer-only idle read ${source}`,
    { timeout: 15000 },
    async (context) => {
      const { runtime, shell, initial, send, output } = await interactive(context);
      await send(source);
      const receipt = await shell.waitForPrompt({
        after: initial.generation,
        signal: context.signal,
      });
      assert.equal(receipt.status, 0);
      assert.ok(output().includes("\nIDLE:142[]\n"), output());
      assert.equal(runtime.disposed, false);
      await send("printf '\\nREUSED\\n'");
      await shell.waitForPrompt({ after: receipt.generation, signal: context.signal });
      assert.ok(output().includes("\nREUSED\n"), output());
      context.diagnostic(
        JSON.stringify({
          runtime: "waffle-0.0.108",
          embedding: "production-matching-wake",
          timer: "idle",
          status: 142,
          reused: true,
        }),
      );
    },
  );

test(
  "production busy pipeline times out while its producer remains runnable",
  { timeout: 15000 },
  async (context) => {
    const { runtime, shell, initial, send, output } = await interactive(context);
    await send(
      '{ printf ab; while :; do :; done; } | { IFS= read -r -t 0.3 x; status=$?; printf \'\\nTIMEOUT:%s[%s]\\n\' "$status" "$x"; }',
    );
    try {
      await until(context, () => output().includes("\nTIMEOUT:142[ab]\n"));
      assert.equal(shell.terminal.readPrompt()?.generation, initial.generation, output());
    } finally {
      shell.interrupt();
      const drained = await shell.waitForPrompt({
        after: initial.generation,
        signal: context.signal,
      });
      assert.equal(drained.status, 130, output());
    }
    assert.equal(runtime.disposed, false);
    const after = shell.terminal.readPrompt()?.generation;
    assert.ok(after !== undefined);
    await send("printf '\\nREUSED\\n'");
    await shell.waitForPrompt({ after, signal: context.signal });
    assert.ok(output().includes("\nREUSED\n"), output());
    context.diagnostic(
      JSON.stringify({
        runtime: "waffle-0.0.108",
        timer: "busy",
        status: 142,
        partial: "ab",
        interrupted: 130,
        reused: true,
      }),
    );
  },
);

test("fallback interactive embedding honors timer-only idle read", { timeout: 15000 }, async () => {
  const { api: fallbackApi, runInteractive } = await import("./own-shell-interactive.ts");
  let phase = 0;
  let step = 0;
  const finiteWaits: number[] = [];
  const park = new Int32Array(new SharedArrayBuffer(4));
  const result = runInteractive({
    args: ["shell-runtime"],
    terminal: () => ({
      inherited_fd: (index: number) => [0, 1, 2][index] ?? -1,
      columns: () => 80,
      rows: () => 24,
      phase: (next: number) => {
        phase = next;
      },
      ...fallbackApi.noPromptHost,
    }),
    onWait(milliseconds) {
      if (phase !== 2) return;
      finiteWaits.push(milliseconds);
      assert.ok(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 10);
      Atomics.wait(park, 0, 0, milliseconds);
    },
    next(output) {
      if (step === 0) {
        step++;
        return encoder.encode("read -t0.3 x; printf '\\nFALLBACK:%s\\n' \"$?\"\r");
      }
      if (phase === 2) return undefined;
      assert.ok(output.includes("\nFALLBACK:142\n"), output);
      step++;
      return encoder.encode("exit 0\r");
    },
  });
  assert.equal(result.status, 0, result.errors);
  assert.ok(result.inputClosed);
  assert.ok(finiteWaits.length > 1);
  assert.equal(step, 2);
});
