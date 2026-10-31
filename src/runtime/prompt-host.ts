// Original. The page side of the prompt hook. createShell loads this module only
// when a page passes a prompt provider. The page never waits on the shell: one loop
// per shell answers the worker's requests and pushes updates for the prompt on screen.
import { control, type SharedBridge } from "../bridge";
import type { PromptContext, PromptLive, PromptProvider } from "../prompt-hook";
import type { ShellOptions } from "../shell";
import { FIRST_ANSWER_MS, PROMPT_BYTES, PromptChannel, promptWord } from "./prompt-channel";

export interface PromptHostOptions {
  provider: PromptProvider;
  terminal: SharedBridge;
  lineEditor: ShellOptions["lineEditor"];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Wakes the shell at its prompt: SIGWINCH to the shell's own process. */
  wake(): void;
}
export interface PromptHost {
  readonly buffer: SharedArrayBuffer;
  stop(): void;
}
/** What the guest sends; see PromptContext in shell/engine/src/runtime_main.rs. */
interface Request {
  cwd: string;
  status: number;
  pipestatus: number[];
  duration_ms: number | null;
  jobs: number;
  ps1: string;
  variables: Record<string, string>;
}
interface Turn {
  readonly number: number;
  shown(): void;
  end(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const shellName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function startPromptHost(options: PromptHostOptions): PromptHost {
  const channel = new PromptChannel();
  const report = reporter();
  const encode = (text: string) => promptBytes(text, report);
  let names: string | undefined;
  let current: Turn | undefined;
  let stopped = false;
  const writeNames = () => {
    let next: string;
    try {
      next = options.provider.variables.filter((name) => shellName.test(name)).join(",");
    } catch (error) {
      return report(error);
    }
    if (next === names) return;
    names = next;
    let bytes = encoder.encode(next);
    if (bytes.length > channel.names.length) {
      report(new Error("Prompt variable names exceed 1 KiB; the rest are left out"));
      // Whole names only: up to the last comma that fits, or none when the first is too long.
      bytes = bytes.subarray(0, Math.max(0, bytes.lastIndexOf(44, channel.names.length)));
    }
    channel.names.set(bytes);
    channel.store(promptWord.namesLength, bytes.length);
  };
  const begin = (turn: number): Turn => {
    const length = channel.load(promptWord.requestLength);
    const request = JSON.parse(decoder.decode(channel.request.slice(0, length))) as Request;
    const firstAnswer = new AbortController();
    const prompt = new AbortController();
    const timer = setTimeout(() => firstAnswer.abort(), FIRST_ANSWER_MS);
    let pending: unknown;
    let scheduled = false;
    let pushed: string | undefined;
    let due = false;
    let shown = false;
    const signal = () => {
      if (!due || !shown || prompt.signal.aborted) return;
      due = false;
      options.wake();
    };
    const flush = () => {
      scheduled = false;
      if (prompt.signal.aborted) return;
      let text: string;
      try {
        text = cleanPromptText(String(pending));
      } catch (error) {
        return report(error);
      }
      if (text === pushed) return;
      const bytes = encode(text);
      if (!bytes) return;
      pushed = text;
      const lock = channel.load(promptWord.updateLock);
      channel.store(promptWord.updateLock, lock + 1);
      channel.update.set(bytes);
      channel.store(promptWord.updateTurn, turn);
      channel.store(promptWord.updateLength, bytes.length);
      channel.store(promptWord.updateLock, lock + 2);
      due = true;
      signal();
    };
    const live: PromptLive = {
      signal: prompt.signal,
      update(text) {
        if (prompt.signal.aborted) return;
        pending = text;
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
      },
    };
    let answered = false;
    const reply = (text: unknown) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      firstAnswer.abort();
      writeNames();
      if (prompt.signal.aborted || channel.load(promptWord.requestTurn) !== turn) return;
      const bytes =
        text === null || text === undefined ? undefined : encode(cleanPromptText(String(text)));
      if (bytes) channel.reply.set(bytes);
      channel.store(promptWord.replyLength, bytes ? bytes.length : -1);
      channel.store(promptWord.replyTurn, turn);
      channel.notify(promptWord.replyTurn);
    };
    const fail = (error: unknown) => {
      if (answered) return;
      report(error);
      reply(null);
    };
    const context: PromptContext = {
      turn,
      cwd: request.cwd,
      status: request.status,
      pipestatus: request.pipestatus,
      durationMs: request.duration_ms ?? undefined,
      jobs: request.jobs,
      columns: Math.max(2, Atomics.load(options.terminal.state, control.cols)),
      rows: Math.max(2, Atomics.load(options.terminal.state, control.rows)),
      lineEditor: options.lineEditor?.mode ?? "bash",
      ps1: request.ps1,
      variables: new Map(Object.entries(request.variables)),
      signal: firstAnswer.signal,
    };
    try {
      const answer: unknown = options.provider.render(context, live);
      // A thenable's `then` is read once, as Promise resolution does; an accessor may
      // answer differently on a second read.
      const then = thenOf(answer);
      if (then) then.call(answer, reply, fail);
      else reply(answer);
    } catch (error) {
      fail(error);
    }
    return {
      number: turn,
      shown() {
        shown = true;
        signal();
      },
      end() {
        clearTimeout(timer);
        firstAnswer.abort();
        prompt.abort();
      },
    };
  };
  const observe = () => {
    const requested = channel.load(promptWord.requestTurn);
    if (requested > (current?.number ?? 0)) {
      current?.end();
      try {
        current = begin(requested);
      } catch (error) {
        current = undefined;
        return report(error);
      }
    }
    if (!current) return;
    if (channel.load(promptWord.endedTurn) >= current.number) current.end();
    else if (channel.load(promptWord.shownTurn) >= current.number) current.shown();
  };
  const loop = async () => {
    while (!stopped) {
      const event = channel.load(promptWord.event);
      observe();
      await Atomics.waitAsync(channel.words, promptWord.event, event).value;
    }
  };
  writeNames();
  try {
    options.provider.prepare?.({ cwd: options.cwd, env: options.env });
  } catch (error) {
    report(error);
  }
  void loop();
  return {
    buffer: channel.buffer,
    stop() {
      if (stopped) return;
      stopped = true;
      current?.end();
      channel.event();
    },
  };
}

type Then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) => unknown;
function thenOf(value: unknown): Then | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const then: unknown = (value as { then?: unknown }).then;
  return typeof then === "function" ? (then as Then) : undefined;
}

/** Logs each distinct provider failure once per shell. */
function reporter() {
  const seen = new Set<string>();
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (seen.has(message)) return;
    seen.add(message);
    console.error("bash-web prompt provider:", error);
  };
}

function promptBytes(text: string, report: (error: unknown) => void): Uint8Array | undefined {
  const bytes = encoder.encode(text);
  if (bytes.length <= PROMPT_BYTES) return bytes;
  report(new Error("Prompt text over 8 KiB after cleaning; the shell keeps its prompt"));
}

/**
 * Keeps printable text, `\n`, SGR (`ESC [ … m`), OSC 8 hyperlinks and OSC 133 marks.
 * Every other control byte and sequence is removed whole: cursor movement would break
 * the editor's model of where the prompt and the command are.
 */
export function cleanPromptText(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === 0x1b) {
      const end = escapeEnd(text, at);
      if (keptEscape(text.slice(at, end))) out += text.slice(at, end);
      at = end;
      continue;
    }
    if (code === 0x0a || !isControl(code)) out += text[at];
    at++;
  }
  return out;
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** The end of the escape sequence at `at`. A malformed sequence ends at the byte that broke it. */
function escapeEnd(text: string, at: number): number {
  const kind = text[at + 1];
  if (kind === "[") {
    let end = at + 2;
    while (within(text, end, 0x20, 0x3f)) end++;
    return within(text, end, 0x40, 0x7e) ? end + 1 : end;
  }
  if (kind === "]") {
    const bell = text.indexOf("\x07", at);
    const st = text.indexOf("\x1b\\", at + 2);
    if (bell < 0 && st < 0) return text.length;
    if (bell < 0 || (st >= 0 && st < bell)) return st + 2;
    return bell + 1;
  }
  return within(text, at + 1, 0x20, 0x7e) ? at + 2 : at + 1;
}

function within(text: string, at: number, low: number, high: number): boolean {
  const code = text.charCodeAt(at);
  return code >= low && code <= high;
}

function keptEscape(sequence: string): boolean {
  if (sequence[1] === "[") return /^\[[0-9;:]*m$/.test(sequence.slice(1));
  if (!sequence.startsWith("\x1b]8;") && !sequence.startsWith("\x1b]133;")) return false;
  const terminator = sequence.endsWith("\x07") ? 1 : sequence.endsWith("\x1b\\") ? 2 : 0;
  if (!terminator) return false;
  const payload = sequence.slice(2, -terminator);
  return !Array.from(payload).some((character) => isControl(character.charCodeAt(0)));
}
