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
  | { resize: [number, number] }
  | { cancel: true };
const hex = (text: string) => Buffer.from(text).toString("hex");
const left = (count: number) => "\x1b[D".repeat(count);

function replay(columns: number, rows: number, steps: readonly Step[]) {
  const script = steps.map((step) => {
    if ("prompt" in step) return `prompt ${hex(step.prompt)}`;
    if ("keys" in step) return `keys ${hex(step.keys)}`;
    if ("output" in step) return `output ${hex(step.output)}`;
    if ("resize" in step) return `resize ${step.resize.join(" ")}`;
    return "cancel";
  });
  const run = spawnSync(replayer, [String(columns), String(rows)], {
    input: script.join("\n") + "\n",
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const terminal = runtime.createTerminal({ columns, rows });
  const submitted: string[] = [];
  let written = "";
  for (const record of run.stdout.trim().split("\n")) {
    const [kind, first = "", second = ""] = record.split(" ");
    if (kind === "W") {
      terminal.write(Buffer.from(first, "hex"));
      written += Buffer.from(first, "hex").toString("latin1");
    }
    if (kind === "S") submitted.push(Buffer.from(first, "hex").toString());
    if (kind === "R") terminal.resize({ columns: Number(first), rows: Number(second) });
  }
  const result = { written, submitted, ...snapshot(terminal) };
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
const prompts = (lines: readonly string[]) => lines.filter((line) => line.startsWith("$ ")).length;

test("the checked-in width table matches the pinned terminal", async () => {
  const table = await readFile(resolve(root, "shell/engine/src/terminal_width.rs"), "utf8");
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
