import { leb, name, section } from "./terminal-wasi-guest";

/** Original WASI guest: publish readiness, wait for SIGINT, then choose its own exit. */
export function signalStatusGuest(mode: "handled" | "default" | "removed" | "once", status = 0) {
  const imports = [
    ["runtime_proc", "signal", 0],
    ["runtime_proc", "interrupted", 1],
    ["runtime_proc", "poll", 2],
    ["runtime_proc", "write", 3],
    ["wasi_snapshot_preview1", "proc_exit", 4],
  ] as const;
  const importsHeader: number[] = [imports.length];
  const ready = new TextEncoder().encode("SIGNAL_READY\n");
  const handled = new TextEncoder().encode("SIGNAL_HANDLED\n");
  const disposition = (value: number) => [0x41, 2, 0x41, value, 0x10, 0, 0x1a];
  const write = (offset: number, length: number) =>
    [0x03, 0x40, 0x41, 1, 0x41].concat(
      leb(offset),
      [0x41],
      leb(length),
      [0x10, 3, 0x41, 0, 0x48, 0x0d, 0, 0x0b],
    );
  let setup = disposition(mode === "default" ? 0 : 2);
  if (mode === "once") setup = setup.concat(disposition(3), [0x10, 1, 0x1a]);
  if (mode === "removed" || mode === "once") setup = setup.concat(disposition(0));
  const body = [0].concat(
    setup,
    write(0, ready.length),
    [
      0x02,
      0x40,
      0x03,
      0x40, // block, loop
      0x10,
      1,
      0x0d,
      1, // interrupted() breaks the block
      0x41,
      0,
      0x41,
      0,
      0x41,
      0x7f,
      0x41,
      0,
      0x10,
      2,
      0x1a,
      0x0c,
      0,
      0x0b,
      0x0b,
    ],
    write(32, handled.length),
    [0x41],
    leb(status),
    [0x10, 4, 0x0b],
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
      section(7, [2].concat(name("memory"), [2, 0], name("_start"), [0, 5])),
      section(10, [1].concat(leb(body.length), body)),
      section(
        11,
        [2, 0, 0x41, 0, 0x0b].concat(
          leb(ready.length),
          Array.from(ready),
          [0, 0x41, 32, 0x0b],
          leb(handled.length),
          Array.from(handled),
        ),
      ),
    ),
  );
}
