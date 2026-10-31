// The real interactive guest under --prompt-host, driven through Waffle's ProcessABI.
// A pushed prompt arrives by SIGWINCH while input is incomplete, so the editor defers it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInteractive } from "./own-shell-interactive.ts";
const encoder = new TextEncoder();
type Input = string | Uint8Array;
interface Host {
  /** Writes newer prompt text and sends SIGWINCH, as the page does. */
  push(text: string): undefined;
  /** Another writer's terminal output, such as a background job. */
  job(text: string): void;
}

/** Runs the guest; each step sees the output so far and the prompt-host controls. */
function promptHost(steps: readonly ((output: string, host: Host) => Input | undefined)[]) {
  let update: Uint8Array | undefined;
  let waits = 0;
  let host: Host | undefined;
  const result = runInteractive({
    args: ["shell-runtime", "-i", "--prompt-host"],
    terminal(guest) {
      const put = (value: Uint8Array, pointer: number) => {
        new Uint8Array(guest.memory().buffer, pointer, value.length).set(value);
        return value.length;
      };
      host = {
        push(text) {
          update = encoder.encode(text);
          guest.kill(28);
          return undefined;
        },
        job(text) {
          guest.inject(encoder.encode(text));
        },
      };
      return {
        inherited_fd: (index: number) => [0, 1, 2][index] ?? -1,
        columns: () => 20,
        rows: () => 6,
        phase() {},
        prompt_names: () => 0,
        prompt: (_turn: number, _context: number, _length: number, pointer: number) =>
          put(encoder.encode("$ "), pointer),
        prompt_update(_turn: number, pointer: number) {
          if (!update) return -1;
          const pushed = update;
          update = undefined;
          return put(pushed, pointer);
        },
        // The bridge's output counter: every byte written to the terminal, by anyone.
        output_position: guest.written,
      };
    },
    next(output) {
      const step = steps[waits++];
      assert.ok(waits <= steps.length && host, "unexpected extra read from the interactive guest");
      const next = step(output, host);
      return next === undefined || typeof next !== "string" ? next : encoder.encode(next);
    },
  });
  assert.equal(result.status, 130, result.errors);
  assert.equal(waits, steps.length);
}

const deferrals: [string, Input, Input, string][] = [
  ["bracketed paste", "\x1b[200~ab", "cd\x1b[201~", "abcd"],
  ["escape sequence", "abcd\x1b[", "D", "abcd"],
  ["split UTF-8", new Uint8Array([0x61, 0x62, 0xc3]), new Uint8Array([0xa9]), "abé"],
];

for (const [name, partial, rest, line] of deferrals) {
  test(`a prompt deferred during ${name} is drawn when the input completes`, () => {
    let mark = 0;
    promptHost([
      () => partial,
      (_output, host) => host.push("NEW> "),
      (output) => {
        mark = output.length;
        return rest;
      },
      (output) => {
        assert.ok(output.slice(mark).includes(`NEW> ${line}`), JSON.stringify(output));
        return "\x03";
      },
      () => "\x04",
    ]);
  });

  test(`a prompt deferred during ${name} is not drawn over a background job's output`, () => {
    let mark = 0;
    promptHost([
      () => partial,
      (_output, host) => host.push("NEW> "),
      (output, host) => {
        host.job("JOB\r\n");
        mark = output.length + "JOB\r\n".length;
        return rest;
      },
      (output) => {
        assert.ok(!output.slice(mark).includes("NEW> "), JSON.stringify(output.slice(mark)));
        mark = output.length;
        return "\x0c";
      },
      (output) => {
        assert.ok(output.slice(mark).includes(`NEW> ${line}`), "Ctrl+L shows the newest text");
        return "\x03";
      },
      () => "\x04",
    ]);
  });
}
