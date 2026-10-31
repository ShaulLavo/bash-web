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
  while (input.offset < delta.length) {
    await work.checkpoint();
    const opcode = input.byte();
    requireObject(opcode !== 0, "Invalid Git delta opcode");
    const copy = opcode & 128 ? copyRange(input, opcode) : { start: input.offset, size: opcode };
    const source = opcode & 128 ? base : delta;
    requireObject(copy.start + copy.size <= source.length && offset + copy.size <= size);
    output.set(source.subarray(copy.start, copy.start + copy.size), offset);
    offset += copy.size;
    if (!(opcode & 128)) input.offset += copy.size;
  }
  requireObject(offset === size, "Git delta result size mismatch");
  return output;
}

function copyRange(input: ObjectCursor, opcode: number): { start: number; size: number } {
  let start = 0;
  let size = 0;
  for (let bit = 0; bit < 4; bit++) {
    if (opcode & (1 << bit)) start += input.byte() * 2 ** (bit * 8);
  }
  for (let bit = 0; bit < 3; bit++) {
    if (opcode & (16 << bit)) size += input.byte() * 2 ** (bit * 8);
  }
  return { start, size: size || 65_536 };
}
