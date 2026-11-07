import { declareModuleMemory, pages, type MemoryDeclaration } from "waffle";

// The standalone shell producer owns one defined, private, capped memory. Waffle's
// public declaration writer records it for child launches but returns no root list.
function rootMemory(source: Uint8Array): readonly MemoryDeclaration[] {
  const bytes = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 8;
  const integer = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bytes.getUint8(offset++);
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  while (offset < source.length) {
    const section = bytes.getUint8(offset++);
    const end = integer() + offset;
    if (section !== 5) {
      offset = end;
      continue;
    }
    if (integer() !== 1 || integer() !== 1)
      throw new TypeError("Shell requires one defined private memory with a maximum");
    integer(); // Initial pages are not charged for private memories.
    return [{ kind: "private", origin: "defined", maximumPages: pages(integer()) }];
  }
  return [];
}

export async function compileShellModule(source: ArrayBuffer): Promise<{
  module: WebAssembly.Module;
  memory: readonly MemoryDeclaration[];
}> {
  const module = await WebAssembly.compile(source);
  const bytes = new Uint8Array(source);
  declareModuleMemory(module, bytes);
  if (WebAssembly.Module.imports(module).some((entry) => entry.kind === "memory"))
    throw new TypeError("Shell memory must be defined by its guest");
  return { module, memory: rootMemory(bytes) };
}
