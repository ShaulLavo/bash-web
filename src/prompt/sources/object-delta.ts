import { ObjectCursor, objectLimit, requireObject, type ObjectWork } from "./object-work";

export async function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
  work: ObjectWork,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new ObjectCursor(delta);
  requireObject(input.variable() === base.length, "Git delta base size mismatch");
  const size = input.variable();
  requireObject(size <= objectLimit, "Git delta exceeds 8 MiB");
  const output = new Uint8Array(size);
  let offset = 0;
  while (input.remaining > 0) {
    await work.checkpoint();
    const opcode = input.byte();
    requireObject(opcode !== 0, "Invalid Git delta opcode");
    const bytes = opcode & 128 ? copyFromBase(base, input, opcode) : input.take(opcode);
    requireObject(offset + bytes.length <= size);
    output.set(bytes, offset);
    offset += bytes.length;
  }
  requireObject(offset === size, "Git delta result size mismatch");
  return output;
}

function copyFromBase(base: Uint8Array, input: ObjectCursor, opcode: number): Uint8Array {
  let start = 0;
  let size = 0;
  for (let bit = 0; bit < 4; bit++) {
    if (opcode & (1 << bit)) start += input.byte() * 2 ** (bit * 8);
  }
  for (let bit = 0; bit < 3; bit++) {
    if (opcode & (16 << bit)) size += input.byte() * 2 ** (bit * 8);
  }
  const end = start + (size || 65_536);
  requireObject(end <= base.length);
  return base.subarray(start, end);
}
