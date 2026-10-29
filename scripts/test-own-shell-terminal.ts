import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
const api: typeof import("./waffle-node-api.ts") = await import(
  new URL("../.build/node/api.mjs", import.meta.url).href
);
const guest = await WebAssembly.compile(
  await readFile(
    resolve(
      process.env.CARGO_TARGET_DIR ?? ".build/shell",
      "wasm32-wasip1/release/shell-runtime.wasm",
    ),
  ),
);
const encoder = new TextEncoder();
const enable = "\x1b[?2004h";
const disable = "\x1b[?2004l";

function interactive(
  steps: readonly ((output: string, phase: number, status: number) => string | null)[],
  exitStatus = 0,
) {
  const input = new api.PipeController({ relay: "manual" });
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  const namespaces: WebAssembly.Imports = {};
  const fs = new api.MemFS();
  const wasi = new api.Wasi({
    namespaces,
    args: ["shell-runtime"],
    env: { PWD: "/" },
    fs,
    preopens: { "/": "/" },
    reservedFds: [0, 1, 2],
    stdout: (bytes) => output.push(bytes.slice()),
    stderr: (bytes) => errors.push(bytes.slice()),
    sleep() {
      throw new Error("editor must use runtime input");
    },
  });
  const supervisor = new api.ProcessSupervisor({
    registry: new api.ExecutableRegistry(),
    launch() {
      throw new Error("test uses builtins only");
    },
  });
  try {
    const pid = supervisor.createRoot({ descriptors: wasi.descriptors });
    const feed = input.retain(pid + 1, "write");
    wasi.descriptors.close(0);
    wasi.descriptors.openAt(0, input.retain(pid, "read"), (1n << 29n) - 1n, 0n);
    let memory: WebAssembly.Memory | undefined;
    let phase = 0;
    let status = 0;
    let pauses = 0;
    const signals = supervisor.get(pid);
    assert.ok(signals);
    const abi = new api.ProcessABI({
      memory: () => {
        assert.ok(memory);
        return memory;
      },
      descriptors: wasi.descriptors,
      fs,
      pid,
      service: supervisor,
      signals,
      wait() {
        const step = steps[pauses++];
        assert.ok(step, "unexpected extra read from the interactive guest");
        const next = step(Buffer.concat(output).toString(), phase, status);
        if (next === null) {
          feed.close();
          return;
        }
        const bytes = encoder.encode(next);
        assert.equal(feed.tryWrite([bytes]), bytes.length);
      },
    });
    namespaces.runtime_proc = abi.imports;
    namespaces.shell_terminal = {
      inherited_fd: (index: number) => [0, 1, 2][index] ?? -1,
      columns: () => 12,
      phase: (next: number, result: number) => {
        phase = next;
        status = result;
      },
    };
    const instance = new WebAssembly.Instance(guest, wasi.imports(guest));
    assert.ok(instance.exports.memory instanceof WebAssembly.Memory);
    memory = instance.exports.memory;
    assert.equal(wasi.start(instance), exitStatus, Buffer.concat(errors).toString());
    assert.equal(pauses, steps.length);
    return Buffer.concat(output).toString();
  } finally {
    supervisor.dispose();
    wasi.descriptors.dispose();
    input.dispose();
    assert.ok(input.closed);
  }
}

function prompt(output: string, phase: number) {
  assert.equal(phase, 1);
  assert.ok(output.endsWith(`${enable}$ `), JSON.stringify(output));
  assert.ok(output.lastIndexOf(enable) > output.lastIndexOf(disable));
}

test("runtime prompt brackets paste, holds multiline commands and disables mode for execution", () => {
  const output = interactive([
    (output, phase) => {
      prompt(output, phase);
      return "\x1b[200~echo FIRST\r\necho SECOND\r\x1b[201~";
    },
    (output, phase) => {
      assert.equal(phase, 1);
      assert.ok(!output.includes(disable));
      assert.ok(!output.includes("\r\nFIRST\r\n"));
      assert.ok(!output.includes("\r\nSECOND\r\n"));
      return "\r";
    },
    (output, phase) => {
      prompt(output, phase);
      assert.ok(
        output.includes(`${disable}\r\nFIRST\nSECOND\n${enable}$ `),
        JSON.stringify(output),
      );
      return "read answer; printf 'READ:%s\\n' \"$answer\"\r";
    },
    (output, phase) => {
      assert.equal(phase, 2);
      assert.ok(output.lastIndexOf(disable) > output.lastIndexOf(enable));
      return "answer\n";
    },
    (output, phase) => {
      prompt(output, phase);
      return "\x04";
    },
  ]);
  assert.ok(output.endsWith(`${disable}\r\n`));
});

test("runtime prompt rearms paste after cancellation and empty input, and disables it on exit", () => {
  const output = interactive([
    (output, phase) => {
      prompt(output, phase);
      return "\x1b[200~old\nvalue\x1b[201~\x03";
    },
    (output, phase) => {
      prompt(output, phase);
      assert.ok(output.includes("^C\r\n"));
      return "\r";
    },
    (output, phase) => {
      prompt(output, phase);
      return "exit 0\r";
    },
  ]);
  assert.ok(output.endsWith(`${disable}\r\n`));
});

test("runtime disables bracketed paste on input EOF, including an unfinished paste", () => {
  const output = interactive([
    (output, phase) => {
      prompt(output, phase);
      return "\x1b[200~unfinished\r\n";
    },
    (_output, phase) => {
      assert.equal(phase, 1);
      return null;
    },
  ]);
  assert.ok(output.endsWith(`${disable}\r\n`));
});

test("runtime accepts a capped paste ending at a UTF-8 boundary", () => {
  const output = interactive([
    (output, phase) => {
      prompt(output, phase);
      return "\x1b[200~#" + "a".repeat(65529);
    },
    (_output, phase) => {
      assert.equal(phase, 1);
      return "aaaaaé\r\nignored\x1b[201~";
    },
    (_output, phase) => {
      assert.equal(phase, 1);
      return "\r";
    },
    (output, phase) => {
      prompt(output, phase);
      assert.equal(output.split("\x07").length - 1, 1);
      assert.ok(!output.includes("command is not UTF-8"));
      return "echo AFTER_CAP\r";
    },
    (output, phase) => {
      prompt(output, phase);
      assert.ok(output.includes("AFTER_CAP\n"));
      return "\x04";
    },
  ]);
  assert.ok(output.endsWith(`${disable}\r\n`));
});

test("runtime publishes the shell result at each real prompt without probing commands", () => {
  const cases = [
    { source: "false", status: 1 },
    { source: "true", status: 0 },
    { source: "cd /missing", status: 1 },
    { source: "if ;", status: 2 },
    { source: "echo $((1/0))", status: 1 },
    { source: "missing-command", status: 127 },
    { source: "false | true", status: 0 },
    { source: "true | false", status: 1 },
    { source: "\x03", status: 130 },
    { source: "", status: 130 },
    { source: "true &", status: 0 },
  ];
  let expected = 0;
  interactive(
    cases.map(({ source, status }) => (output, phase, result) => {
      prompt(output, phase);
      assert.equal(result, expected, source);
      expected = status;
      return source + "\r";
    }).concat([(output, phase, result) => {
      prompt(output, phase);
      assert.equal(result, expected);
      return "exit 0\r";
    }]),
  );
});
