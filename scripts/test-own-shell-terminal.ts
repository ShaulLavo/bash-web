import assert from "node:assert/strict";
import { test } from "node:test";
import { api, runInteractive } from "./own-shell-interactive.ts";
const encoder = new TextEncoder();
const enable = "\x1b[?2004h";
const disable = "\x1b[?2004l";

function interactive(
  steps: readonly ((output: string, phase: number, status: number) => string | null)[],
  exitStatus = 0,
) {
  const bridge = new api.SharedBridge();
  const terminal = api.shellTerminalImports(bridge.buffer);
  let phase = 0;
  let status = 0;
  let generation = 0n;
  let pauses = 0;
  const result = runInteractive({
    args: ["shell-runtime"],
    terminal: () => ({
      inherited_fd: (index: number) => [0, 1, 2][index] ?? -1,
      columns: () => 12,
      rows: () => 6,
      phase: (next: number, value: number) => {
        phase = next;
        status = value;
        terminal.phase(next, value);
        if (next !== 1) return;
        assert.deepEqual(bridge.readPrompt(), { generation: ++generation, status: value });
      },
      ...api.noPromptHost,
    }),
    next(output) {
      const step = steps[pauses++];
      assert.ok(step, "unexpected extra read from the interactive guest");
      const text = step(output, phase, status);
      return text === null ? null : encoder.encode(text);
    },
  });
  assert.equal(result.status, exitStatus, result.errors);
  assert.equal(pauses, steps.length);
  assert.ok(result.inputClosed);
  return result.output;
}

function prompt(output: string, phase: number) {
  assert.equal(phase, 1, output.slice(-300));
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
    { source: "false | true", status: 0 },
    { source: "true | false", status: 1 },
    { source: "\x03", status: 130 },
    { source: "", status: 130 },
  ];
  let expected = 0;
  const steps: Parameters<typeof interactive>[0] = cases
    .map(({ source, status }) => (output: string, phase: number, result: number) => {
      prompt(output, phase);
      assert.equal(result, expected, source);
      expected = status;
      return source + "\r";
    })
    .concat([
      (output, phase, result) => {
        prompt(output, phase);
        assert.equal(result, expected);
        return "exit 0\r";
      },
    ]);
  interactive(steps);
});
