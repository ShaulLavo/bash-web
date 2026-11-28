import assert from "node:assert/strict";

const wasmHeader = Buffer.of(0, 97, 115, 109, 1, 0, 0, 0);
const nameSection = Buffer.from("name");

function unsigned(bytes: Buffer, start: number) {
  let value = 0;
  let shift = 0;
  for (let next = start; next < start + 5; next++) {
    const byte = bytes[next];
    assert.notEqual(byte, undefined, "Truncated Wasm length");
    value += (byte & 127) * 2 ** shift;
    assert.ok(value <= 0xffff_ffff, "Oversized Wasm length");
    if (!(byte & 128)) return { value, next: next + 1 };
    shift += 7;
  }
  throw new Error("Oversized Wasm length");
}

function isNameSection(body: Buffer) {
  const size = unsigned(body, 0);
  const end = size.next + size.value;
  assert.ok(end <= body.length, "Truncated Wasm custom section name");
  return body.subarray(size.next, end).equals(nameSection);
}

// Preserve the encoded bytes of all other sections.
export function stripNames(bytes: Buffer) {
  assert.ok(bytes.subarray(0, wasmHeader.length).equals(wasmHeader), "Expected a Wasm module");
  const retained = [bytes.subarray(0, wasmHeader.length)];
  let offset = wasmHeader.length;
  let kept = offset;
  let nameOffset: number | undefined;
  while (offset < bytes.length) {
    const start = offset;
    const kind = bytes[offset++];
    const size = unsigned(bytes, offset);
    offset = size.next + size.value;
    assert.ok(offset <= bytes.length, "Truncated Wasm section body");
    if (kind === 0 && isNameSection(bytes.subarray(size.next, offset))) {
      nameOffset ??= kept;
      continue;
    }
    retained.push(bytes.subarray(start, offset));
    kept += offset - start;
  }
  return { bytes: nameOffset === undefined ? bytes : Buffer.concat(retained, kept), nameOffset };
}
