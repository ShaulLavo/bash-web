import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { WorkBudget } from "./live";
import { parseIndex } from "./sources/index-file";
import { ObjectCursor } from "./sources/object-work";

test("truncated index v4 prefixes reject before reading the checksum", async () => {
  for (const prefix of [[], [128], [128, 128]]) {
    const bytes = new Uint8Array(12 + 62 + prefix.length + 20);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x44495243);
    view.setUint32(4, 4);
    view.setUint32(8, 1);
    view.setUint32(36, 0o100644);
    bytes.set(prefix, 74);
    bytes.set(createHash("sha1").update(bytes.subarray(0, -20)).digest(), bytes.length - 20);
    const budget = new WorkBudget(new AbortController().signal, 2000);
    await assert.rejects(parseIndex(bytes, budget), /invalid index prefix/u);
  }
});

test("object byte cursor rejects exhaustion without advancing", () => {
  const cursor = new ObjectCursor(Uint8Array.of(0, 255));
  assert.equal(cursor.byte(), 0);
  assert.equal(cursor.byte(), 255);
  assert.equal(cursor.offset, 2);
  assert.throws(() => cursor.byte(), /Invalid Git object/u);
  assert.equal(cursor.offset, 2);
});
