export function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}
export function name(value: string): number[] {
  return leb(value.length).concat(Array.from(new TextEncoder().encode(value)));
}
export function section(id: number, bytes: number[]): number[] {
  return [id].concat(leb(bytes.length), bytes);
}
