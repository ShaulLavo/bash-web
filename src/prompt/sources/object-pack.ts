import { digest, hex, requireObject, type ObjectWork } from "./object-work";

export class PackIndex {
  private readonly view: DataView;
  readonly count: number;
  readonly ends = new Map<number, number>();
  private readonly offsets: number[] = [];

  private constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    requireObject(
      bytes.length >= 1_072 && this.u32(0) === 0xff744f63 && this.u32(4) === 2,
      "Unsupported Git pack index",
    );
    this.count = this.u32(1_028);
    requireObject(this.count <= 200_000 && bytes.length >= 1_072 + this.count * 28);
  }

  static async parse(bytes: Uint8Array, work: ObjectWork): Promise<PackIndex> {
    const index = new PackIndex(bytes);
    requireObject(
      (await digest(new Uint8Array(bytes.subarray(0, -20)))) === hex(bytes.subarray(-20)),
      "Git pack index checksum mismatch",
    );
    let bucket = 0;
    let previous = "";
    for (let position = 0; position < index.count; position++) {
      await work.checkpoint();
      const name = index.name(position);
      requireObject(name > previous, "Unsorted Git pack index");
      const prefix = Number.parseInt(name.slice(0, 2), 16);
      while (bucket < prefix) {
        requireObject(index.u32(8 + bucket * 4) === position, "Invalid Git pack fanout");
        bucket++;
      }
      previous = name;
      index.offsets.push(index.offset(position));
    }
    while (bucket < 256) {
      requireObject(index.u32(8 + bucket * 4) === index.count, "Invalid Git pack fanout");
      bucket++;
    }
    index.offsets.sort((left, right) => left - right);
    for (let position = 0; position < index.offsets.length; position++) {
      const start = index.offsets[position];
      const end = index.offsets[position + 1] ?? 0;
      requireObject(start >= 12 && (!end || end > start));
      index.ends.set(start, end);
      await work.checkpoint();
    }
    return index;
  }

  find(name: string): number | undefined {
    const prefix = Number.parseInt(name.slice(0, 2), 16);
    let low = prefix === 0 ? 0 : this.u32(8 + (prefix - 1) * 4);
    let high = this.u32(8 + prefix * 4);
    requireObject(low <= high && high <= this.count);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.name(middle);
      if (candidate === name) return this.offset(middle);
      if (candidate < name) low = middle + 1;
      else high = middle;
    }
    return undefined;
  }

  private name(position: number): string {
    const start = 1_032 + position * 20;
    return hex(this.bytes.subarray(start, start + 20));
  }

  private offset(position: number): number {
    const value = this.u32(1_032 + this.count * 24 + position * 4);
    if (value < 0x80000000) return value;
    const start = 1_032 + this.count * 28 + (value - 0x80000000) * 8;
    requireObject(start + 8 <= this.bytes.length - 40);
    const offset = this.u32(start) * 2 ** 32 + this.u32(start + 4);
    requireObject(Number.isSafeInteger(offset));
    return offset;
  }

  private u32(offset: number): number {
    requireObject(offset + 4 <= this.bytes.length);
    return this.view.getUint32(offset);
  }
}
