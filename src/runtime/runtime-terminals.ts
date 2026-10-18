// Adapted from brush-web src/runtime/runtime-terminals.ts at a2a4e96.
// Its bounded bridge endpoints originated in bun-wasm web/src/runtime-terminals.ts at
// 8d3d416aa9cb23718ed3487a33d0b06e8e373672. Waffle owns descriptor transport; only the
// shared-terminal stream policy lives here; token codecs stay in Waffle.
import type { Stream } from "waffle/core";
import { SharedBridge, control } from "../bridge";
import {
  attachTerminal,
  createTerminalAdmission,
  terminalSection,
  type TerminalAdmission,
} from "./terminal-admission";

type TerminalTarget = 0 | 1 | 2;
const AGAIN = -6;

export function createBridgeTerminal(
  buffer: SharedArrayBuffer,
  target: TerminalTarget,
  checkActive: () => void = () => {},
  admission = createTerminalAdmission(),
): Stream {
  attachTerminal(admission, buffer);
  const bridge = new SharedBridge(buffer);
  const notification = new Int32Array(buffer, control.wake * 4, 1);
  const tryRead = (chunks: readonly Uint8Array[]) => {
    checkActive();
    return terminalSection(admission, () =>
      Atomics.load(bridge.state, control.phase) === 4
        ? -29
        : target === 0
          ? bridge.tryRead(chunks)
          : -8,
    );
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
      const pending =
        (Atomics.load(bridge.state, control.outputWrite) -
          Atomics.load(bridge.state, control.outputRead)) >>>
        0;
      return {
        readable: target === 0 && (bridge.availableInput() !== 0 || bridge.closed()),
        writable: target !== 0 && !bridge.closed() && pending < bridge.output.length,
        hangup: bridge.closed(),
        nbytes: target === 0 ? bridge.availableInput() : bridge.output.length - pending,
      };
    },
  };
  return stream;
}
