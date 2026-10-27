// Adapted from brush-web src/runtime/runtime-terminals.ts at a2a4e96.
// Its bounded bridge endpoints originated in bun-wasm web/src/runtime-terminals.ts at
// 8d3d416aa9cb23718ed3487a33d0b06e8e373672. Waffle owns descriptor transport; only the
// shared-terminal stream policy lives here; token codecs stay in Waffle.
import type { Stream } from "waffle/core";
import { SharedBridge, control } from "../bridge";
import { attachTerminal, createTerminalAdmission, terminalSection } from "./terminal-admission";

type TerminalTarget = 0 | 1 | 2;
const AGAIN = -6;
const lineStates = new WeakMap<SharedArrayBuffer, { skipLineFeed: boolean }>();

export function createBridgeTerminal(
  buffer: SharedArrayBuffer,
  target: TerminalTarget,
  checkActive: () => void = () => {},
  admission = createTerminalAdmission(),
): Stream {
  attachTerminal(admission, buffer);
  const bridge = new SharedBridge(buffer);
  const notification = new Int32Array(buffer, control.wake * 4, 1);
  const lineState = lineStates.get(buffer) ?? { skipLineFeed: false };
  lineStates.set(buffer, lineState);
  const tryRead = (chunks: readonly Uint8Array[]) => {
    checkActive();
    return terminalSection(admission, () => {
      const phase = Atomics.load(bridge.state, control.phase);
      if (phase === 4) return -29;
      // Targets identify inherited terminal destinations, not descriptor rights.
      // Waffle checks FD_READ before invoking this shared input stream.
      if (bridge.cancelled()) return AGAIN;
      // This bounded browser-terminal adapter deliberately keeps the interactive
      // editor raw so it can handle CR/LF and redraw itself. Once a command is
      // running, shell builtins read from the same terminal as a cooked line
      // stream. CR (and CRLF within this admitted stream) is one LF; this is not
      // a general Waffle TTY discipline, and pipes/files remain byte-exact because
      // they never use this endpoint.
      if (phase !== 2) {
        lineState.skipLineFeed = false;
        return bridge.tryRead(chunks);
      }
      const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (!length) return 0;
      const available = bridge.availableInput();
      if (!available && !bridge.closed()) return AGAIN;
      const raw = new Uint8Array(Math.min(length, bridge.input.length, Math.max(available, 1)));
      const count = bridge.tryRead([raw]);
      if (count <= 0) return count;
      let written = 0;
      let destination = 0;
      for (const byte of raw.subarray(0, count)) {
        if (lineState.skipLineFeed && byte === 10) {
          lineState.skipLineFeed = false;
          continue;
        }
        lineState.skipLineFeed = byte === 13;
        const normalized = byte === 13 ? 10 : byte;
        let chunk = chunks[destination];
        while (chunk && written === chunk.length) {
          chunk = chunks[++destination];
          written = 0;
        }
        if (!chunk) break;
        chunk[written++] = normalized;
      }
      const output = chunks
        .slice(0, destination + 1)
        .reduce((total, chunk, index) => total + (index < destination ? chunk.length : written), 0);
      // A split CRLF can consume the LF while producing no byte. Signal the
      // normal retry path instead of exposing a false EOF to the stream caller.
      return output || (count > 0 ? AGAIN : count);
    });
  };
  const tryWrite = (chunks: readonly Uint8Array[]) => {
    checkActive();
    return terminalSection(admission, () =>
      Atomics.load(bridge.state, control.phase) === 4
        ? -29
        : target === 0
          ? -8
          : bridge.tryWrite(chunks),
    );
  };
  const blocking = (
    operation: (chunks: readonly Uint8Array[]) => number,
    chunks: readonly Uint8Array[],
  ) => {
    for (;;) {
      const sequence = Atomics.load(notification, 0);
      const result = operation(chunks);
      if (result !== AGAIN) return result;
      if (operation === tryRead && bridge.cancelled()) return -27;
      Atomics.wait(notification, 0, sequence, 10);
    }
  };
  const stream: Stream = {
    kind: "terminal",
    notification,
    tryRead,
    tryWrite,
    read: (chunks) => blocking(tryRead, chunks),
    write: (chunks) => blocking(tryWrite, chunks),
    readiness() {
      checkActive();
      if (
        terminalSection(admission, () =>
          Atomics.load(bridge.state, control.phase) === 4 ? -29 : 0,
        )
      )
        return { readable: false, writable: false, hangup: true, nbytes: 0 };
      const pending =
        (Atomics.load(bridge.state, control.outputWrite) -
          Atomics.load(bridge.state, control.outputRead)) >>>
        0;
      return {
        readable: !bridge.cancelled() && (bridge.availableInput() !== 0 || bridge.closed()),
        writable: target !== 0 && !bridge.closed() && pending < bridge.output.length,
        hangup: bridge.closed(),
        nbytes: bridge.availableInput(),
      };
    },
  };
  return stream;
}
