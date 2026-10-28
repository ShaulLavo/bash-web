import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalResult,
} from "waffle/browser/runtime-terminals";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { terminalGuest } from "../../tests/helpers/terminal-wasi-guest";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

for (const target of [1, 2] as const) {
  test(`session terminal target ${target} preserves FD_READ and the shared fd0 input cursor`, (context) => {
    const root = createWorkerProcessTransport({ capacity: 8 });
    const input = createTerminalInput();
    const display = createTerminalSession({
      controller: root,
      geometry: { columns: 80, rows: 24 },
    });
    context.after(() => display.close("disposed"));
    const policy = createTerminalInputPolicy({ input });
    const authority = must(
      claimTerminalAuthority({
        identity: display.identity,
        process: root,
        checkActive() {},
        policy,
      }),
    );
    const editor = must(authority.createGroup({ initialMode: "raw" }));
    const member = must(authority.admitExisting({ group: editor, pid: root.pid }));
    must(authority.acquire({ group: editor, expected: null }));
    const attachment = attachTerminal({
      context: member.context,
      process: root,
      checkActive() {},
      policy,
    });
    context.after(() => attachment.dispose());
    const guest = terminalGuest({
      0: attachment.resolve(0),
      1: attachment.resolve(1),
      2: attachment.resolve(2),
    });
    context.after(() => guest.wasi.descriptors.dispose());
    const descriptor = guest.wasi.descriptors.get(target)!;
    const endpoint = descriptor.resource;
    assert.ok(endpoint.kind === "terminal");
    assert.equal(endpoint.readiness().readable, false);
    const keys = Uint8Array.of(65, 66, 67);
    assert.equal(must(pushTerminalInput(display, input, keys)), 3);
    assert.equal(endpoint.readiness().readable, true);
    assert.deepEqual(guest.poll(target), { error: 0, nbytes: 3n, flags: 0 });
    assert.equal(guest.io("fd_read", 0, 1), 0);
    assert.equal(guest.bytes[256], 65);
    assert.deepEqual(guest.poll(target), { error: 0, nbytes: 2n, flags: 0 });
    assert.notEqual(descriptor.rightsBase & 2n, 0n);
    assert.equal(
      guest.io("fd_read", target, 1),
      0,
      "read-capable terminal shares the input cursor",
    );
    assert.equal(guest.bytes[256], 66);
    assert.equal(guest.io("fd_read", 0, 1), 0);
    assert.equal(guest.bytes[256], 67);
    assert.equal(input.available(), 0);
    assert.equal(endpoint.readiness().readable, false);
    assert.equal(must(pushTerminalInput(display, input, Uint8Array.of(68))), 1);
    descriptor.rightsBase &= ~2n;
    assert.equal(guest.io("fd_read", target, 1), 76, "FD_READ denial leaves the input untouched");
    assert.equal(input.available(), 1);
    guest.wasi.descriptors.close(target);
    assert.equal(guest.io("fd_read", target, 1), 8, "closed terminal descriptors stay closed");
    assert.equal(input.available(), 1);
    assert.equal(guest.io("fd_read", 0, 1), 0);
    assert.equal(guest.bytes[256], 68);
    assert.equal(input.available(), 0);
  });
}
