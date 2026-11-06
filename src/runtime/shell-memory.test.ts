import assert from "node:assert/strict";
import { test } from "node:test";
import { pages } from "waffle";
import { leb, name, section } from "../../tests/helpers/wasm-binary";
import { compileShellModule } from "./shell-memory";

const header = [0, 97, 115, 109, 1, 0, 0, 0];

for (const maximum of [3, 4096, 65536]) {
  test(`root declaration comes from the compiled guest's ${maximum}-page cap`, async () => {
    const source = new Uint8Array(header.concat(section(5, [1, 1, 1].concat(leb(maximum)))));
    const loaded = await compileShellModule(source.buffer);
    assert.ok(loaded.module instanceof WebAssembly.Module);
    assert.deepEqual(loaded.memory, [
      { kind: "private", origin: "defined", maximumPages: pages(maximum) },
    ]);
  });
}

test("a guest with no memory declares no memory from its actual bytes", async () => {
  const loaded = await compileShellModule(new Uint8Array(header).buffer);
  assert.deepEqual(loaded.memory, []);
});

test("imported memory is refused rather than omitted from root accounting", async () => {
  const source = new Uint8Array(
    header.concat(section(2, [1].concat(name("env"), name("memory"), [2, 1, 1, 3]))),
  );
  await assert.rejects(compileShellModule(source.buffer), /must be defined by its guest/);
});

for (const limits of [
  [0, 1],
  [3, 1, 3],
]) {
  test(`unsupported shell memory flags ${limits[0]} fail before admission`, async () => {
    const source = new Uint8Array(header.concat(section(5, [1].concat(limits))));
    await assert.rejects(
      compileShellModule(source.buffer),
      /defined private memory with a maximum/,
    );
  });
}
