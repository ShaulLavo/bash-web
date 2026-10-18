// Original tiny WASI fixture: emit raw ff00 on stdout, "err" on stderr, exit 7.
// No shell semantics or host accounts are involved.
export function fixture(outputSize = 2) {
  const leb = (number: number) => {
    const bytes = [];
    do {
      const byte = number & 127;
      number >>>= 7;
      bytes.push(byte | (number ? 128 : 0));
    } while (number);
    return bytes;
  };
  const string = (value: string) => leb(value.length).concat(Array.from(Buffer.from(value)));
  const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
  const imports = [2].concat(
    string("wasi_snapshot_preview1"),
    string("fd_write"),
    [0, 0],
    string("wasi_snapshot_preview1"),
    string("proc_exit"),
    [0, 1],
  );
  const body = [
    0, 0x41, 1, 0x41, 0, 0x41, 1, 0x41, 16, 0x10, 0, 0x1a, 0x41, 2, 0x41, 8, 0x41, 1, 0x41, 16,
    0x10, 0, 0x1a, 0x41, 7, 0x10, 1, 0x0b,
  ];
  const data = Buffer.alloc(37);
  data.writeUInt32LE(32, 0);
  data.writeUInt32LE(outputSize, 4);
  data.writeUInt32LE(34, 8);
  data.writeUInt32LE(3, 12);
  data.set([255, 0, 101, 114, 114], 32);
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      section(2, imports),
      section(3, [1, 2]),
      section(5, [1, 0].concat(leb(Math.ceil((outputSize + 32) / 65536)))),
      section(7, [2].concat(string("memory"), [2, 0], string("_start"), [0, 2])),
      section(10, [1].concat(leb(body.length), body)),
      section(11, [1, 0, 0x41, 0, 0x0b].concat(leb(data.length), Array.from(data))),
    ),
  );
}
