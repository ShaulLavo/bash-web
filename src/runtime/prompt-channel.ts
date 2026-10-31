// Original. The shared memory between the page's prompt host and the shell worker.
// Only a shell created with a prompt provider has one. The worker writes requests and
// turn changes; the page writes replies, pushed updates and the variable names.
export const promptWord = {
  /** Bumped by the worker on every request and turn change; the page waits on it. */
  event: 0,
  requestTurn: 1,
  requestLength: 2,
  replyTurn: 3,
  /** -1 means "draw PS1". */
  replyLength: 4,
  /** The turn whose prompt is on screen. */
  shownTurn: 5,
  /** The turn whose prompt has ended: Enter ran a command or the shell exited. */
  endedTurn: 6,
  /** Odd while the page writes an update, even when it is stable. */
  updateLock: 7,
  updateTurn: 8,
  updateLength: 9,
  namesLength: 10,
} as const;
export const PROMPT_BYTES = 8 * 1024;
const HEADER_BYTES = 64;
const REQUEST_BYTES = 16 * 1024;
const NAME_BYTES = 1024;
const sections = { request: REQUEST_BYTES, reply: PROMPT_BYTES, update: PROMPT_BYTES };
const offsets = {
  request: HEADER_BYTES,
  reply: HEADER_BYTES + sections.request,
  update: HEADER_BYTES + sections.request + sections.reply,
  names: HEADER_BYTES + sections.request + sections.reply + sections.update,
};
/** The shell gives up on the first answer after this and draws PS1. */
export const FIRST_ANSWER_MS = 100;

export class PromptChannel {
  readonly words: Int32Array;
  readonly request: Uint8Array;
  readonly reply: Uint8Array;
  readonly update: Uint8Array;
  readonly names: Uint8Array;
  constructor(readonly buffer = new SharedArrayBuffer(offsets.names + NAME_BYTES)) {
    this.words = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.request = new Uint8Array(buffer, offsets.request, REQUEST_BYTES);
    this.reply = new Uint8Array(buffer, offsets.reply, PROMPT_BYTES);
    this.update = new Uint8Array(buffer, offsets.update, PROMPT_BYTES);
    this.names = new Uint8Array(buffer, offsets.names, NAME_BYTES);
  }
  load(word: number): number {
    return Atomics.load(this.words, word);
  }
  store(word: number, value: number): void {
    Atomics.store(this.words, word, value);
  }
  notify(word: number): void {
    Atomics.notify(this.words, word);
  }
  /** Worker side: wakes the page's loop after a request or a turn change. */
  event(): void {
    Atomics.add(this.words, promptWord.event, 1);
    this.notify(promptWord.event);
  }
}

/**
 * The shell's `shell_terminal` prompt imports, plus the phase hook that records which
 * turn is on screen. Without a channel the imports answer -1; the guest calls them
 * only under `--prompt-host`.
 */
export function promptGuest(
  buffer: SharedArrayBuffer | undefined,
  memory: () => WebAssembly.Memory | undefined,
  outputPosition: () => number,
) {
  const channel = buffer && new PromptChannel(buffer);
  let applied = 0;
  const guest = (pointer: number, length: number) =>
    new Uint8Array(memory()!.buffer, pointer >>> 0, length >>> 0);
  const copyOut = (bytes: Uint8Array, pointer: number, capacity: number) => {
    if (bytes.length > capacity) return -1;
    guest(pointer, bytes.length).set(bytes);
    return bytes.length;
  };
  const imports = {
    prompt_names(pointer: number, capacity: number): number {
      if (!channel) return -1;
      const length = channel.load(promptWord.namesLength);
      return copyOut(channel.names.subarray(0, length), pointer, capacity);
    },
    prompt(turn: number, context: number, length: number, pointer: number, capacity: number) {
      if (!channel || length > channel.request.length) return -1;
      channel.request.set(guest(context, length));
      channel.store(promptWord.requestLength, length);
      channel.store(promptWord.requestTurn, turn);
      channel.event();
      const deadline = performance.now() + FIRST_ANSWER_MS;
      for (;;) {
        const answered = channel.load(promptWord.replyTurn);
        if (answered === turn) break;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return -1;
        Atomics.wait(channel.words, promptWord.replyTurn, answered, remaining);
      }
      const reply = channel.load(promptWord.replyLength);
      if (reply < 0) return -1;
      return copyOut(channel.reply.subarray(0, reply), pointer, capacity);
    },
    prompt_update(turn: number, pointer: number, capacity: number): number {
      if (!channel) return -1;
      const lock = channel.load(promptWord.updateLock);
      if (lock & 1 || lock === applied || channel.load(promptWord.updateTurn) !== turn) return -1;
      const length = channel.load(promptWord.updateLength);
      const copied = copyOut(channel.update.subarray(0, length), pointer, capacity);
      // A page write that overlapped the copy sends another wake when it is done.
      if (channel.load(promptWord.updateLock) !== lock) return -1;
      applied = lock;
      return copied;
    },
    output_position: outputPosition,
  };
  const phase = (value: number) => {
    if (!channel || (value !== 0 && value !== 1 && value !== 2)) return;
    const turn = channel.load(promptWord.requestTurn);
    channel.store(value === 1 ? promptWord.shownTurn : promptWord.endedTurn, turn);
    channel.event();
  };
  return { imports, phase };
}
