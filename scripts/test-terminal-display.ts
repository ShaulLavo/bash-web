// Replays the line editor's actual output into the pinned libghostty-vt and checks
// the screen, history and cursor against the same text written straight to a terminal.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { ghosttyRuntime } from "./ghostty-vt.ts";
import { generatedWidthTable } from "./terminal-widths.ts";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "shell/target");
execFileSync(
  "cargo",
  ["build", "--locked", "--manifest-path", "shell/Cargo.toml", "-p", "shell-engine"].concat([
    "--example",
    "terminal_replay",
  ]),
  { cwd: root, stdio: "inherit" },
);
const replayer = resolve(target, "debug/examples/terminal_replay");
const runtime = await ghosttyRuntime();
after(() => runtime.dispose());

type Step =
  | { prompt: string }
  | { keys: string }
  | { output: string }
  | { update: string }
  | { background: string }
  | { resize: [number, number] }
  | { cancel: true }
  | { eof: true };
const hex = (text: string) => Buffer.from(text).toString("hex");
const left = (count: number) => "\x1b[D".repeat(count);

function replay(columns: number, rows: number, steps: readonly Step[], mode = "bash") {
  const script = steps.map((step) => {
    if ("prompt" in step) return `prompt ${hex(step.prompt)}`;
    if ("keys" in step) return `keys ${hex(step.keys)}`;
    if ("output" in step) return `output ${hex(step.output)}`;
    if ("update" in step) return `update ${hex(step.update)}`;
    if ("background" in step) return `background ${hex(step.background)}`;
    if ("resize" in step) return `resize ${step.resize.join(" ")}`;
    return "cancel" in step ? "cancel" : "eof";
  });
  const run = spawnSync(replayer, [String(columns), String(rows), mode], {
    input: script.join("\n") + "\n",
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const terminal = runtime.createTerminal({ columns, rows });
  const submitted: string[] = [];
  const repaints: Buffer[] = [];
  let written = "";
  for (const record of run.stdout.trim().split("\n")) {
    const [kind, first = "", second = ""] = record.split(" ");
    if (kind === "W") {
      // Echo writes one byte at a time; anything longer is a repaint or a finish.
      if (first.length > 2) repaints.push(Buffer.from(first, "hex"));
      terminal.write(Buffer.from(first, "hex"));
      written += Buffer.from(first, "hex").toString("latin1");
    }
    if (kind === "S") submitted.push(Buffer.from(first, "hex").toString());
    if (kind === "R") terminal.resize({ columns: Number(first), rows: Number(second) });
  }
  const result = { written, submitted, repaints, ...snapshot(terminal) };
  terminal.dispose();
  return result;
}

type Terminal = ReturnType<typeof runtime.createTerminal>;
function snapshot(terminal: Terminal) {
  const lines = terminal.readLines(0, terminal.totalRows).map((line) => line.text.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const history = terminal.scrollbackLength;
  const { x, y, pendingWrap } = terminal.cursor;
  // A pending wrap is drawn on the next row's first cell, where the editor puts its caret.
  const cursor = pendingWrap
    ? { row: history + y + 1, column: 0 }
    : { row: history + y, column: x };
  return { lines, screen: lines.slice(history), cursor };
}

/** The terminal after writing `text`, with the cursor where `caret` (a prefix) ends. */
function direct(columns: number, rows: number, text: string, caret = text) {
  const screen = runtime.createTerminal({ columns, rows });
  screen.write(text);
  const { lines } = snapshot(screen);
  screen.dispose();
  const prefix = runtime.createTerminal({ columns, rows: 1000 });
  prefix.write(caret);
  const { cursor } = snapshot(prefix);
  prefix.dispose();
  return { lines, cursor };
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
const prompts = (lines: readonly string[]) => lines.filter((line) => line.startsWith("$ ")).length;

test("the checked-in width table matches the pinned terminal", async () => {
  const table = await readFile(resolve(root, "shell/engine/src/terminal/width.rs"), "utf8");
  assert.equal(table, await generatedWidthTable(), "run node scripts/terminal-widths.ts");
});

test("editing inside wrapped rows matches text written directly", () => {
  const cases: [string, string, string][] = [
    ["ascii", `echo abcdefghijklmnop${left(2)}Z`, "echo abcdefghijklmnZ|op"],
    ["wide", `echo 中中中中${left(1)}Z`, "echo 中中中Z|中"],
    ["cyrillic mark", `echo a҃ xyz${left(1)}Z`, "echo a҃ xyZ|z"],
    ["hebrew point", `echo שָ xyz${left(1)}Z`, "echo שָ xyZ|z"],
    ["zwj emoji", `echo 👨‍👩‍👧‍👦 xyz${left(1)}Z`, "echo 👨‍👩‍👧‍👦 xyZ|z"],
    ["variation selector", `echo ❤️ xyz${left(1)}Z`, "echo ❤️ xyZ|z"],
    ["skin tone", `echo 👍🏽 xyz${left(1)}Z`, "echo 👍🏽 xyZ|z"],
    ["flag", `echo 🇺🇸 xyz${left(1)}Z`, "echo 🇺🇸 xyZ|z"],
    ["devanagari", `echo क्षि xyz${left(1)}Z`, "echo क्षि xyZ|z"],
    ["hangul jamo", `echo 각 xyz${left(1)}Z`, "echo 각 xyZ|z"],
    ["soft hyphen", `echo a­b xyz${left(1)}Z`, "echo a­b xyZ|z"],
    ["new unicode", `echo \u{18d00}\u{16ff0} xyz${left(1)}Z`, "echo \u{18d00}\u{16ff0} xyZ|z"],
    ["wide at margin", `echo abcd中 xyz${left(1)}Z`, "echo abcd中 xyZ|z"],
  ];
  for (const [name, keys, expected] of cases) {
    const result = replay(12, 6, [{ prompt: "$ " }, { keys }]);
    const [before, after] = expected.split("|");
    const reference = direct(12, 6, `$ ${before}${after}`, `$ ${before}`);
    assert.deepEqual(result.lines, reference.lines, name);
    assert.deepEqual(result.cursor, reference.cursor, name);
  }
});

test("enter and interrupts from an earlier wrapped row leave the command intact", () => {
  const command = "echo abcdefghijklmnop";
  const submitted = replay(12, 6, [
    { prompt: "$ " },
    { keys: `${command}\x01\r` },
    { output: "OUT\r\n" },
    { prompt: "$ " },
  ]);
  assert.deepEqual(submitted.submitted, [command]);
  assert.deepEqual(submitted.lines, ["$ echo abcde", "fghijklmnop", "OUT", "$"]);
  for (const interrupt of [{ keys: "\x03" }, { cancel: true }] as const) {
    const result = replay(12, 6, [
      { prompt: "$ " },
      { keys: "echo abcdefghij\x01" },
      interrupt,
      { prompt: "$ " },
    ]);
    assert.deepEqual(result.lines, ["$ echo abcde", "fghij^C", "$"]);
    assert.deepEqual(result.cursor, { row: 2, column: 2 });
  }
});

test("a command ending at the right margin gets no blank row after enter or ^C", () => {
  for (const [ending, expected] of [
    ["\r", ["$ abcdef", "OUT", "$"]],
    ["\x03", ["$ abcdef", "^C", "OUT", "$"]],
  ] as const) {
    const result = replay(8, 6, [
      { prompt: "$ " },
      { keys: `abcdef\x1b[D\x1b[C${ending}` },
      { output: "OUT\r\n" },
      { prompt: "$ " },
    ]);
    assert.deepEqual(result.lines, expected);
  }
  const typed = replay(8, 6, [{ prompt: "$ " }, { keys: "abcdef\x1b[D\x1b[Cgh" }]);
  assert.deepEqual(typed.lines, ["$ abcdef", "gh"]);
  assert.deepEqual(typed.cursor, { row: 1, column: 2 });
});

test("editing a command taller than the screen keeps one copy in history", () => {
  const command = "abcdefghijklmnopqrstuvwx1234567890";
  const edits: [string, string, string][] = [
    [`${left(1)}Z`, "abcdefghijklmnopqrstuvwx123456789Z0", "abcdefghijklmnopqrstuvwx123456789Z"],
    ["\x7f\x7f\x7f", "abcdefghijklmnopqrstuvwx1234567", "abcdefghijklmnopqrstuvwx1234567"],
    [`${left(9)}\x0b`, "abcdefghijklmnopqrstuvwx1", "abcdefghijklmnopqrstuvwx1"],
    [`${left(12)}\x1b[3~`, "abcdefghijklmnopqrstuvx1234567890", "abcdefghijklmnopqrstuv"],
    [`${left(20)}${"\x1b[C".repeat(20)}!`, `${command}!`, `${command}!`],
  ];
  for (const [keys, text, caret] of edits) {
    const result = replay(8, 3, [{ prompt: "$ " }, { keys: command + keys }]);
    const reference = direct(8, 3, `$ ${text}`, `$ ${caret}`);
    assert.deepEqual(result.lines, reference.lines, JSON.stringify(keys));
    assert.deepEqual(result.cursor, reference.cursor, JSON.stringify(keys));
    assert.equal(prompts(result.lines), 1, JSON.stringify(keys));
  }
});

test("recalling and submitting a tall command keeps output below it", () => {
  const command = "abcdefghijklmnopqrstuvwx1234567890";
  const result = replay(8, 3, [
    { prompt: "$ " },
    { keys: `${command}\r` },
    { output: "OUT\r\n" },
    { prompt: "$ " },
    { keys: `\x1b[A${left(3)}Z\r` },
    { output: "OUT\r\n" },
    { prompt: "$ " },
  ]);
  const second = direct(8, 1000, `$ abcdefghijklmnopqrstuvwx1234567Z890`).lines;
  assert.deepEqual(result.submitted, [command, "abcdefghijklmnopqrstuvwx1234567Z890"]);
  assert.deepEqual(
    result.lines,
    direct(8, 1000, `$ ${command}`).lines.concat(["OUT"], second, ["OUT", "$"]),
  );
});

test("moving into rows that scrolled away shows the caret's row at the top", () => {
  const command = "abcdefghijklmnopqrstuvwx1234567890";
  const home = replay(8, 3, [{ prompt: "$ " }, { keys: `${command}\x01` }]);
  assert.deepEqual(home.screen, ["$ abcdef", "ghijklmn", "opqrstuv"]);
  assert.deepEqual(home.cursor, { row: home.lines.length - 3, column: 2 });
  const back = replay(8, 3, [{ prompt: "$ " }, { keys: `${command}\x01\x05!` }]);
  const end = direct(8, 3, `$ ${command}!`);
  assert.deepEqual(back.screen, end.lines.slice(-3));
  assert.deepEqual(back.cursor.column, end.cursor.column);
  const result = replay(8, 3, [{ prompt: "$ " }, { keys: `${command}\x01X` }]);
  assert.deepEqual(result.screen, ["$ Xabcde", "fghijklm", "nopqrstu"]);
  assert.deepEqual(result.cursor.row - (result.lines.length - result.screen.length), 0);
  assert.equal(result.cursor.column, 3);
  const finished = replay(8, 3, [
    { prompt: "$ " },
    { keys: `${command}\x01X\r` },
    { output: "OUT\r\n" },
  ]);
  const full = direct(8, 1000, `$ X${command}`).lines;
  // History keeps the rows that had scrolled away before the caret moved up.
  assert.deepEqual(finished.lines.slice(-full.length - 1), full.concat(["OUT"]));
});

test("ctrl-l clears the screen and repaints the prompt and command", () => {
  const result = replay(12, 6, [
    { output: "OLD OUTPUT\r\n" },
    { prompt: "$ " },
    { keys: `draft${left(2)}\x0c` },
  ]);
  assert.deepEqual(result.screen, ["$ draft"]);
  assert.ok(!result.screen.includes("OLD OUTPUT"));
  const history = result.lines.length - result.screen.length;
  assert.deepEqual(result.cursor, { row: history, column: 5 });
  const typed = replay(12, 6, [
    { output: "OLD OUTPUT\r\n" },
    { prompt: "$ " },
    { keys: `echo abcdefghijklmnop\x0cX\r` },
  ]);
  assert.deepEqual(typed.submitted, ["echo abcdefghijklmnopX"]);
  assert.deepEqual(typed.screen, ["$ echo abcde", "fghijklmnopX"]);
});

test("resizing recounts the reflowed command before the next edit", () => {
  const narrowed = replay(12, 6, [
    { prompt: "$ " },
    { keys: `abcdefghijklmnopqrst${left(4)}` },
    { resize: [8, 6] },
    { keys: "Z" },
  ]);
  const reference = direct(8, 6, "$ abcdefghijklmnopZqrst", "$ abcdefghijklmnopZ");
  assert.deepEqual(narrowed.lines, reference.lines);
  assert.deepEqual(narrowed.cursor, reference.cursor);
  const shortened = replay(8, 6, [
    { prompt: "$ " },
    { keys: `abcdefghijklmnopqrstuvwx1234567890${left(1)}` },
    { resize: [8, 3] },
    { keys: "Z" },
  ]);
  const tall = direct(
    8,
    3,
    "$ abcdefghijklmnopqrstuvwx123456789Z0",
    "$ abcdefghijklmnopqrstuvwx123456789Z",
  );
  assert.deepEqual(shortened.lines, tall.lines);
  assert.deepEqual(shortened.cursor, tall.cursor);
});

test("multiline commands repaint hard rows and leave output below them", () => {
  const newline = "\x1b[27;2;13~";
  const margin = replay(8, 6, [{ prompt: "$ " }, { keys: `abcdef${newline}gh${left(1)}Z` }]);
  assert.deepEqual(margin.lines, ["$ abcdef", "gZh"]);
  assert.deepEqual(margin.cursor, { row: 1, column: 2 });
  const pasted = replay(12, 6, [
    { prompt: "$ " },
    { keys: "\x1b[200~echo abcdefghijklmnop\r\necho two\x1b[201~\x01\r" },
    { output: "OUT\r\n" },
    { prompt: "$ " },
  ]);
  assert.deepEqual(pasted.submitted, ["echo abcdefghijklmnop\necho two"]);
  assert.deepEqual(pasted.lines, ["$ echo abcde", "fghijklmnop", "echo two", "OUT", "$"]);
  const tall = replay(8, 3, [
    { prompt: "$ " },
    { keys: `one${newline}two${newline}three${newline}four${newline}five${left(2)}Z` },
  ]);
  assert.deepEqual(tall.lines, ["$ one", "two", "three", "four", "fiZve"]);
  assert.deepEqual(tall.cursor, { row: 4, column: 3 });
  const home = replay(8, 3, [
    { prompt: "$ " },
    {
      keys: `one${newline}two${newline}three${newline}four${newline}five\x01X`,
    },
  ]);
  assert.deepEqual(home.screen, ["$ Xone", "two", "three"]);
});

test("a host interrupt or end of input after a resize finishes below the reflowed command", () => {
  const typed: Step[] = [
    { prompt: "$ " },
    { keys: "echo abcdefghijklmnop\x01" },
    { resize: [8, 6] },
  ];
  const cancelled = replay(12, 6, typed.concat([{ cancel: true }, { prompt: "$ " }]));
  assert.deepEqual(cancelled.lines, ["$ echo a", "bcdefghi", "jklmnop^", "C", "$"]);
  const ended = replay(12, 6, typed.concat([{ eof: true }]));
  assert.deepEqual(ended.lines, ["$ echo a", "bcdefghi", "jklmnop"]);
  assert.deepEqual(ended.cursor, { row: 3, column: 0 });
});

test("typing after a cursor move at the right margin matches text written directly", () => {
  const cases: [string, string, string][] = [
    [`abcdef${left(1)}\x1b[C\u0301Z`, "abcdef\u0301Z", "abcdef\u0301Z"],
    [`abcdef${left(1)}\x1b[C\u0301`, "abcdef\u0301", "abcdef\u0301"],
    [`abcdef${left(1)}\x1b[Cé`, "abcdefé", "abcdefé"],
    [`abcdef${left(1)}\x1b[C中`, "abcdef中", "abcdef中"],
    [`abcdef${left(2)}é`, "abcdéef", "abcdé"],
    [`abcdefgh${left(3)}\u0301`, "abcde\u0301fgh", "abcde\u0301"],
  ];
  for (const [keys, text, caret] of cases) {
    const result = replay(8, 6, [{ prompt: "$ " }, { keys }]);
    const reference = direct(8, 6, `$ ${text}`, `$ ${caret}`);
    assert.deepEqual(result.lines, reference.lines, JSON.stringify(keys));
    assert.deepEqual(result.cursor, reference.cursor, JSON.stringify(keys));
    // A repaint between a scalar's bytes would briefly show U+FFFD.
    for (const repaint of result.repaints)
      assert.doesNotThrow(() => utf8.decode(repaint), JSON.stringify(keys));
  }
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
}
function values(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

async function referenceCases(name = "readline-navigation") {
  const document: unknown = JSON.parse(
    await readFile(resolve(root, `tests/terminal/${name}.json`), "utf8"),
  );
  return values(record(document).cases).map((value) => {
    const fixture = record(value);
    assert.ok(typeof fixture.columns === "number");
    const history = values(fixture.history).map((entry) => string(entry));
    const steps: Step[] = [{ prompt: "$ " }];
    for (const entry of history)
      steps.push({ keys: "\x1b[200~" + entry + "\x1b[201~\r" }, { prompt: "$ " });
    const preceding = history.map((entry) => `$ ${entry.replaceAll("\n", "\r\n")}\r\n`).join("");
    return { fixture, columns: fixture.columns, steps, preceding };
  });
}

async function checkNavigationReference(mode: "bash" | "zsh") {
  const name = mode === "bash" ? "readline-navigation" : "zsh-navigation";
  for (const { fixture, columns, steps, preceding } of await referenceCases(name)) {
    if (mode === "bash" && fixture.parity !== true) continue;
    for (const rawStep of values(fixture.steps)) {
      const step = record(rawStep);
      const line = string(step.line);
      assert.ok(typeof step.point === "number");
      const prefix = Buffer.from(line).subarray(0, step.point).toString();
      steps.push({ keys: Buffer.from(string(step.inputHex), "hex").toString() });
      const actual = replay(columns, 100, steps, mode);
      const expected = direct(
        columns,
        100,
        `${preceding}$ ${line.replaceAll("\n", "\r\n")}`,
        `${preceding}$ ${prefix.replaceAll("\n", "\r\n")}`,
      );
      assert.deepEqual(actual.lines, expected.lines, `${fixture.name} ${step.key}`);
      assert.deepEqual(actual.cursor, expected.cursor, `${fixture.name} ${step.key}`);
    }
  }
}

test("Bash 5 byte replay keeps the observed buffer and caret in the pinned VT", () =>
  checkNavigationReference("bash"));
test("zsh 5.9 byte replay paints every observed hard-line and history cursor in the VT", () =>
  checkNavigationReference("zsh"));

test("native Shift key bytes retain explicit newline and safe-CSI policies in the VT", async () => {
  const policies = new Map([
    ["modified-arrows", "one two\n\nthree"],
    ["shift-enter-policy", "# first\n# second"],
  ]);
  for (const { fixture, columns, steps, preceding } of await referenceCases()) {
    if (fixture.parity !== false) continue;
    const expected = policies.get(string(fixture.name));
    assert.ok(expected !== undefined, String(fixture.name));
    const keys = values(fixture.steps)
      .map((entry) => Buffer.from(string(record(entry).inputHex), "hex").toString())
      .join("");
    const actual = replay(columns, 100, steps.concat([{ keys }]));
    const directPolicy = direct(columns, 100, `${preceding}$ ${expected.replaceAll("\n", "\r\n")}`);
    assert.deepEqual(actual.lines, directPolicy.lines, string(fixture.name));
    assert.deepEqual(actual.cursor, directPolicy.cursor, string(fixture.name));
  }
});

test("a pushed prompt repaints in place and keeps the command and caret", () => {
  const keys = { keys: `echo abcdefghij${left(3)}` };
  const cases: [string, number, string, string][] = [
    ["same height", 24, "$ ", "~/app $ "],
    ["one line to two", 24, "$ ", "~/app\r\n$ "],
    ["two lines to one", 24, "~/app\r\n$ ", "$ "],
    ["prompt soft wraps", 12, "$ ", "~/a-long-directory $ "],
    ["command rewraps under a wider prompt", 12, "$ ", "~/app $ "],
  ];
  for (const mode of ["bash", "zsh"])
    for (const [name, columns, before, after] of cases) {
      const result = replay(columns, 6, [{ prompt: before }, keys, { update: after }], mode);
      const reference = direct(columns, 6, `${after}echo abcdefghij`, `${after}echo abcdefg`);
      assert.deepEqual(result.lines, reference.lines, `${mode} ${name}`);
      assert.deepEqual(result.cursor, reference.cursor, `${mode} ${name}`);
      const typed = replay(
        columns,
        6,
        [{ prompt: before }, keys, { update: after }, { keys: "Z\r" }],
        mode,
      );
      assert.deepEqual(typed.submitted, ["echo abcdefgZhij"], `${mode} ${name}`);
    }
});

test("a pushed prompt after a resize starts from the reflowed rows", () => {
  const result = replay(12, 6, [
    { prompt: "$ " },
    { keys: `echo abcdefghijklmnop${left(4)}` },
    { resize: [8, 6] },
    { update: "% " },
  ]);
  const reference = direct(8, 6, "% echo abcdefghijklmnop", "% echo abcdefghijkl");
  assert.deepEqual(result.lines, reference.lines);
  assert.deepEqual(result.cursor, reference.cursor);
});

test("a taller pushed prompt at the bottom of the screen scrolls like written text", () => {
  const result = replay(8, 3, [
    { output: "one\r\ntwo\r\n" },
    { prompt: "$ " },
    { keys: "abc" },
    { update: "~/app\r\n$ " },
  ]);
  const reference = direct(8, 1000, "one\r\ntwo\r\n~/app\r\n$ abc");
  assert.deepEqual(result.lines, reference.lines);
  assert.deepEqual(result.screen, ["two", "~/app", "$ abc"]);
  assert.deepEqual(result.cursor, reference.cursor);
});

test("a prompt that is out of reach is not redrawn until ctrl-l", () => {
  const command = "abcdefghijklmnopqrstuvwx1234567890";
  const cases: [string, Step[]][] = [
    ["background output", [{ prompt: "$ " }, { keys: "ab" }, { background: "JOB\r\n" }]],
    ["first row scrolled away", [{ prompt: "$ " }, { keys: command }]],
  ];
  for (const [name, steps] of cases) {
    const without = replay(8, 3, steps);
    const pushed = replay(8, 3, steps.concat([{ update: "% " }]));
    assert.equal(pushed.written, without.written, name);
    const cleared = replay(8, 3, steps.concat([{ update: "% " }, { keys: "\x0c" }]));
    assert.ok(
      cleared.lines.some((line) => line.startsWith("% ")),
      name,
    );
  }
});

// Split UTF-8 scalars are covered by the native editor tests; keys here are whole strings.
test("a prompt pushed mid-escape or mid-paste is drawn when the input completes", () => {
  const cases: [string, string, string, string][] = [
    ["escape", "ab\x1b[", "D", "% ab"],
    ["paste", "\x1b[200~ab", "cd\x1b[201~", "% abcd"],
  ];
  for (const [name, partial, rest, expected] of cases) {
    const pending = replay(20, 6, [{ prompt: "$ " }, { keys: partial }, { update: "% " }]);
    assert.ok(!pending.lines.some((line) => line.startsWith("%")), name);
    const done = replay(20, 6, [
      { prompt: "$ " },
      { keys: partial },
      { update: "% " },
      { keys: rest },
    ]);
    assert.deepEqual(done.lines, [expected], name);
  }
});
