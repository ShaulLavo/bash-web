// Original prompt hook regressions. The test plays the shell worker's side of the
// channel on the page thread, so nothing here blocks: prompt() itself is not called.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedBridge } from "../bridge";
import type { PromptContext, PromptLive, PromptProvider } from "../prompt-hook";
import { PromptChannel, promptGuest, promptWord } from "./prompt-channel";
import { cleanPromptText, startPromptHost } from "./prompt-host";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000 && !predicate(); attempt++) await tick();
  assert.ok(predicate(), "condition was not reached");
}

function fixture(provider: PromptProvider) {
  const terminal = new SharedBridge();
  terminal.resize(100, 30);
  let wakes = 0;
  const host = startPromptHost({
    provider,
    terminal,
    lineEditor: { mode: "zsh" },
    cwd: "/home/guest",
    env: { HOME: "/home/guest" },
    wake: () => wakes++,
  });
  const channel = new PromptChannel(host.buffer);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guest = promptGuest(
    host.buffer,
    () => memory,
    () => 0,
  );
  const request = async (turn: number, context: object = {}) => {
    const json = encoder.encode(
      JSON.stringify({
        cwd: "/home/guest",
        status: 0,
        pipestatus: [0],
        duration_ms: null,
        jobs: 0,
        ps1: "$ ",
        variables: {},
        ...context,
      }),
    );
    channel.request.set(json);
    channel.store(promptWord.requestLength, json.length);
    channel.store(promptWord.requestTurn, turn);
    channel.event();
  };
  const reply = async (turn: number) => {
    await until(() => channel.load(promptWord.replyTurn) === turn);
    const length = channel.load(promptWord.replyLength);
    return length < 0 ? null : decoder.decode(channel.reply.slice(0, length));
  };
  const update = (turn: number) => {
    const length = guest.imports.prompt_update(turn, 0, 8192);
    return length < 0 ? null : decoder.decode(new Uint8Array(memory.buffer, 0, length).slice());
  };
  return { host, channel, guest, memory, request, reply, update, wakes: () => wakes };
}

test("prompt text keeps printable text, newlines, SGR, OSC 8 and OSC 133 only", () => {
  const kept = [
    "plain é 中 😀",
    "two\nlines",
    "\x1b[1;38;2;1;2;3mbold\x1b[0m",
    "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
    "\x1b]133;A\x07$ ",
  ];
  for (const text of kept) assert.equal(cleanPromptText(text), text, JSON.stringify(text));
  const removed: [string, string][] = [
    ["a\rb\tc\x07d\x7f\u009be", "abcde"],
    ["\x1b[2J\x1b[1Aup\x1b[?25l", "up"],
    ["\x1b]0;title\x07x", "x"],
    ["\x1b]8;;bad\x01url\x07y", "y"],
    ["\x1b[31", ""],
    ["a\x1b", "a"],
    ["\x1bcz", "z"],
    ["\x1b[3\x01m", "m"],
  ];
  for (const [text, expected] of removed)
    assert.equal(cleanPromptText(text), expected, JSON.stringify(text));
});

test("the context carries the shell's facts and the page's geometry", async () => {
  const contexts: PromptContext[] = [];
  const shell = fixture({
    variables: ["HOME", "bad,name", "VIRTUAL_ENV"],
    render(context) {
      contexts.push(context);
      return "> ";
    },
  });
  await shell.request(1, {
    cwd: "/tmp",
    status: 1,
    pipestatus: [0, 1],
    duration_ms: 2513,
    jobs: 2,
    ps1: "$ ",
    variables: { HOME: "/home/guest" },
  });
  assert.equal(await shell.reply(1), "> ");
  const [context] = contexts;
  assert.ok(context);
  assert.deepEqual(
    { ...context, signal: undefined, variables: Object.fromEntries(context.variables) },
    {
      turn: 1,
      cwd: "/tmp",
      status: 1,
      pipestatus: [0, 1],
      durationMs: 2513,
      jobs: 2,
      columns: 100,
      rows: 30,
      lineEditor: "zsh",
      ps1: "$ ",
      variables: { HOME: "/home/guest" },
      signal: undefined,
    },
  );
  assert.ok(context.signal.aborted, "the first-answer signal ends with the answer");
  const names = shell.guest.imports.prompt_names(0, 1024);
  assert.equal(
    decoder.decode(new Uint8Array(shell.memory.buffer, 0, names).slice()),
    "HOME,VIRTUAL_ENV",
  );
  await shell.request(2);
  await shell.reply(2);
  assert.equal(contexts[1]?.durationMs, undefined);
  assert.equal(contexts.length, 2, "the provider is called once per prompt");
  shell.host.stop();
});

test("null, throws, rejections and oversized text draw PS1", async (t) => {
  t.mock.method(console, "error", () => {});
  const answers: (() => string | null | Promise<string | null>)[] = [
    () => null,
    () => {
      throw new Error("broken provider");
    },
    () => Promise.reject(new Error("rejected provider")),
    () => "x".repeat(8193),
  ];
  let turn = 0;
  const shell = fixture({ variables: [], render: () => answers[turn - 1]!() });
  for (turn = 1; turn <= answers.length; turn++) {
    await shell.request(turn);
    assert.equal(await shell.reply(turn), null, `answer ${turn}`);
  }
  shell.host.stop();
});

test("updates coalesce, wait for the prompt to be drawn and stop when it ends", async () => {
  const lives: PromptLive[] = [];
  const shell = fixture({
    variables: [],
    render(_context, live) {
      lives.push(live);
      live.update("early ");
      return "first ";
    },
  });
  await shell.request(1);
  assert.equal(await shell.reply(1), "first ");
  await tick();
  assert.equal(shell.wakes(), 0, "not drawn yet");
  assert.equal(shell.update(1), "early ", "the guest checks once after drawing");
  shell.guest.phase(1);
  await until(() => shell.wakes() === 1);
  assert.equal(shell.update(1), null, "applied once");
  const live = lives[0]!;
  live.update("a ");
  live.update("b ");
  await until(() => shell.wakes() === 2);
  await tick();
  assert.equal(shell.wakes(), 2, "one wake for one task's updates");
  assert.equal(shell.update(2), null, "another turn's update is refused");
  assert.equal(shell.update(1), "b ");
  live.update("b ");
  await tick();
  assert.equal(shell.wakes(), 2, "unchanged text is not pushed");
  shell.guest.phase(2);
  await until(() => live.signal.aborted);
  live.update("late ");
  await tick();
  assert.equal(shell.wakes(), 2);
  shell.host.stop();
});

test("a late first answer is dropped but later updates still repair the prompt", async () => {
  const lives: PromptLive[] = [];
  let contexts: PromptContext[] = [];
  const shell = fixture({
    variables: [],
    render(context, live) {
      contexts.push(context);
      lives.push(live);
      return new Promise<string | null>(() => {});
    },
  });
  await shell.request(1);
  await until(() => contexts[0]?.signal.aborted === true);
  assert.equal(shell.channel.load(promptWord.replyTurn), 0, "never answered");
  shell.guest.phase(1);
  lives[0]!.update("fixed ");
  await until(() => shell.wakes() === 1);
  assert.equal(shell.update(1), "fixed ");
  await shell.request(2);
  await until(() => lives[0]!.signal.aborted);
  contexts = [];
  shell.host.stop();
  assert.ok(lives[1]!.signal.aborted, "stopping the host ends the prompt on screen");
});

test("variable names that overflow the names area keep only whole names that fit", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const cases: [string, string[], string][] = [
    ["one oversized name", ["A".repeat(2048)], ""],
    ["an oversized first name", ["B".repeat(1500), "HOME"], ""],
    ["names past the limit", ["C".repeat(600), "D".repeat(600)], "C".repeat(600)],
  ];
  for (const [name, variables, expected] of cases) {
    const shell = fixture({ variables, render: () => "> " });
    const length = shell.guest.imports.prompt_names(0, 1024);
    assert.equal(
      decoder.decode(new Uint8Array(shell.memory.buffer, 0, length).slice()),
      expected,
      name,
    );
    await shell.request(1);
    assert.equal(await shell.reply(1), "> ", `${name}: the prompt still renders`);
    shell.host.stop();
  }
  assert.equal(errors.mock.callCount(), 3, "one diagnostic per shell");
});

test("a thenable's then is read once and its answer is used", async () => {
  let reads = 0;
  const answer = Promise.resolve("OK> ");
  const thenable = {
    get then() {
      reads++;
      if (reads > 1) throw new Error("then was read twice");
      return answer.then.bind(answer);
    },
  };
  const shell = fixture({ variables: [], render: () => thenable as PromiseLike<string> });
  await shell.request(1);
  assert.equal(await shell.reply(1), "OK> ");
  assert.equal(reads, 1);
  shell.host.stop();
});
