import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { api, directory, nodeDirectory, waffleFixture } from "./own-shell-waffle-fixture.ts";
import { familyWasmPath } from "./family-assets.ts";

const bytes = await readFile(`${directory}/shell-runtime.wasm`);
const wasmUrl = `data:application/wasm;base64,${bytes.toString("base64")}`;
const encoder = new TextEncoder();

async function send(shell: Awaited<ReturnType<typeof api.createShell>>, source: string) {
  const input = encoder.encode(source + "\r");
  let offset = 0;
  while (offset < input.length) {
    const wake = Atomics.load(shell.terminal.state, api.control.wake);
    offset += shell.terminal.send(input.subarray(offset));
    if (offset < input.length)
      await Atomics.waitAsync(shell.terminal.state, api.control.wake, wake).value;
  }
}

test(
  "public prompt API waits for guest startup, commands, interrupts and disposal",
  { timeout: 30000 },
  async (context) => {
    const { runtime } = await waffleFixture(context);
    const shell = await api.createShell({
      runtime,
      wasmUrl,
      workerUrl: new URL("shell.mjs", nodeDirectory),
    });
    context.after(() => shell.dispose());
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
    const { runtime } = await waffleFixture(context);
    const shell = await api.createShell({
      runtime,
      wasmUrl,
      workerUrl: new URL("shell.mjs", nodeDirectory),
      script: "exit 23",
    });
    context.after(() => shell.dispose());
    await assert.rejects(shell.waitForPrompt(), /Shell closed/);
    assert.equal((await shell.done).code, 23);
  },
);
