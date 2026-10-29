import { leb, name, section } from "./wasm-binary";

type SignalMode = "handled" | "default" | "removed" | "once" | "continue" | "reader" | "exit";
function integer(value: number): number[] {
  const bytes = leb(value);
  if ((bytes[bytes.length - 1]! & 64) !== 0) {
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! | 128;
    bytes.push(0);
  }
  return [0x41].concat(bytes);
}
/** Original guest: register SIGINT, publish readiness, then choose its actual exit. */
export function signalStatusGuest(mode: SignalMode, status = 0) {
  const imports = [
    ["runtime_proc", "signal", 0],
    ["runtime_proc", "interrupted", 1],
    ["runtime_proc", "poll", 2],
    ["runtime_proc", "write", 3],
    ["wasi_snapshot_preview1", "proc_exit", 4],
    ["runtime_proc", "read", 3],
  ] as const;
  const importsHeader: number[] = [imports.length];
  const messages = [
    "SIGNAL_READY\n",
    "SIGNAL_HANDLED 1\n",
    "SIGNAL_HANDLED 2\n",
    "READER_INPUT ",
    "\n",
  ];
  const encoded = messages.map((text) => new TextEncoder().encode(text));
  const disposition = (value: number) => integer(2).concat(integer(value), [0x10, 0, 0x1a]);
  const writeBytes = (offset: number, length: number) =>
    [0x03, 0x40].concat(
      integer(1),
      integer(offset),
      integer(length),
      [0x10, 3, 0x41, 0, 0x48, 0x0d, 0, 0x0b],
    );
  const write = (index: number) => writeBytes(index * 32, encoded[index]!.length);
  const poll = [0x41, 0, 0x41, 0, 0x41, 0x7f, 0x41, 0, 0x10, 2, 0x1a];
  const inputReady = integer(160).concat(integer(1), [0x41, 0x7f], integer(176), [0x10, 2, 0x1a]);
  const wait = [0x02, 0x40, 0x03, 0x40, 0x10, 1, 0x0d, 1].concat(poll, [0x0c, 0, 0x0b, 0x0b]);
  let setup = disposition(mode === "default" ? 0 : 2);
  if (mode === "once") setup = setup.concat(disposition(3), [0x10, 1, 0x1a]);
  if (mode === "removed" || mode === "once") setup = setup.concat(disposition(0));
  let action = wait.concat(write(1), integer(status), [0x10, 4]);
  if (mode === "exit") action = integer(status).concat([0x10, 4]);
  if (mode === "continue")
    action = [0x03, 0x40].concat(
      wait,
      [0x20, 0, 0x41, 1, 0x6a, 0x22, 0, 0x41, 1, 0x46, 0x04, 0x40],
      write(1),
      [0x05],
      write(2),
      [0x0b, 0x20, 0, 0x41, 2, 0x47, 0x0d, 0, 0x0b],
      integer(12),
      [0x10, 4],
    );
  if (mode === "reader")
    action = wait.concat(
      write(1),
      [0x02, 0x40, 0x03, 0x40],
      integer(0),
      integer(224),
      integer(1),
      [0x10, 5, 0x22, 0, 0x41, 0, 0x4a, 0x0d, 1, 0x20, 0, 0x45, 0x04, 0x40],
      integer(0),
      [0x10, 4, 0x0b],
      inputReady,
      [0x0c, 0, 0x0b, 0x0b],
      write(3),
      writeBytes(224, 1),
      write(4),
      integer(0),
      [0x10, 4],
    );
  const body = [1, 1, 0x7f].concat(setup, write(0), action, [0x0b]);
  const data = encoded.flatMap((bytes, index) =>
    [0].concat(integer(index * 32), [0x0b], leb(bytes.length), Array.from(bytes)),
  );
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(
        1,
        [
          6, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1,
          0x7f, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0,
        ],
      ),
      section(
        2,
        importsHeader.concat(
          imports.flatMap(([module, field, type]) => name(module).concat(name(field), [0, type])),
        ),
      ),
      section(3, [1, 5]),
      section(5, [1, 0, 1]),
      section(7, [2].concat(name("memory"), [2, 0], name("_start"), [0, imports.length])),
      section(10, [1].concat(leb(body.length), body)),
      section(11, [messages.length].concat(data)),
    ),
  );
}
