import type { TurnFilesystem } from "../fs";
import { applyDelta } from "./object-delta";
import { PackIndex } from "./object-pack";
import {
  decoder,
  digest,
  encoder,
  hex,
  inflate,
  ObjectCursor,
  objectLimit,
  oid,
  requireObject,
  type ObjectWork,
} from "./object-work";

export interface GitObject {
  readonly type: "commit" | "tree" | "blob" | "tag";
  readonly bytes: Uint8Array;
}
interface Pack {
  readonly path: string;
  readonly index: PackIndex;
}

export class ObjectReader {
  private packs: Promise<readonly Pack[]> | undefined;
  private readonly cache = new Map<string, Promise<GitObject>>();
  private readonly offsets = new Map<string, Promise<GitObject>>();
  private retained = 0;

  constructor(
    private readonly filesystem: TurnFilesystem,
    private readonly commonDir: string,
    readonly work: ObjectWork,
  ) {}

  async read(name: string, ancestors: readonly string[] = []): Promise<GitObject> {
    this.work.check();
    oid(name);
    requireObject(
      ancestors.length < 64 && !ancestors.includes(name),
      "Git delta cycle or depth limit",
    );
    const cached = this.cache.get(name);
    if (cached) return cached;
    const result = this.load(name, ancestors.concat(name));
    this.cache.set(name, result);
    return result;
  }

  private async load(name: string, ancestors: readonly string[]): Promise<GitObject> {
    const loose = await this.file(`${this.commonDir}/objects/${name.slice(0, 2)}/${name.slice(2)}`);
    const result = loose ? await this.loose(loose) : await this.packed(name, ancestors);
    this.work.check();
    const header = encoder.encode(`${result.type} ${result.bytes.length}\0`);
    const input = new Uint8Array(header.length + result.bytes.length);
    input.set(header);
    input.set(result.bytes, header.length);
    requireObject((await digest(input)) === name, "Git object checksum mismatch");
    return result;
  }

  private async loose(bytes: Uint8Array): Promise<GitObject> {
    const inflated = await inflate(bytes, this.work);
    const end = inflated.indexOf(0);
    requireObject(end > 0 && end < 64);
    const match = /^(commit|tree|blob|tag) ([0-9]+)$/.exec(
      decoder.decode(inflated.subarray(0, end)),
    );
    requireObject(match && Number(match[2]) === inflated.length - end - 1);
    return this.retain({ type: objectType(match[1]), bytes: inflated.subarray(end + 1) });
  }

  private async packed(name: string, ancestors: readonly string[]): Promise<GitObject> {
    this.packs ??= this.findPacks();
    for (const pack of await this.packs) {
      const offset = pack.index.find(name);
      if (offset !== undefined) return this.unpack(pack, offset, ancestors);
    }
    throw new Error("Git object not found");
  }

  private async findPacks(): Promise<readonly Pack[]> {
    const path = `${this.commonDir}/objects/pack`;
    const directory = await this.filesystem.lookup(path);
    this.work.check();
    if (!directory) return [];
    requireObject(directory.kind === "dir");
    const names = Array.from(directory.children.keys()).filter((name) =>
      /^pack-[0-9a-f]{40}\.idx$/.test(name),
    );
    requireObject(names.length <= 32, "Git pack count exceeds 32");
    const packs: Pack[] = [];
    for (const name of names) {
      const bytes = await this.file(`${path}/${name}`);
      requireObject(bytes, "Missing Git pack index");
      packs.push({
        path: `${path}/${name.slice(0, -4)}.pack`,
        index: await PackIndex.parse(bytes, this.work),
      });
    }
    return packs;
  }

  private async unpack(
    pack: Pack,
    offset: number,
    ancestors: readonly string[],
  ): Promise<GitObject> {
    const key = `${pack.path}:${offset}`;
    requireObject(
      ancestors.length < 64 && !ancestors.includes(key),
      "Git delta cycle or depth limit",
    );
    const cached = this.offsets.get(key);
    if (cached) return cached;
    const pending = this.unpackEntry(pack, offset, ancestors.concat(key));
    this.offsets.set(key, pending);
    return pending;
  }

  private async unpackEntry(
    pack: Pack,
    offset: number,
    ancestors: readonly string[],
  ): Promise<GitObject> {
    const bytes = await this.file(pack.path);
    requireObject(bytes && bytes.length >= 32 && decoder.decode(bytes.subarray(0, 4)) === "PACK");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    requireObject(
      (view.getUint32(4) === 2 || view.getUint32(4) === 3) &&
        view.getUint32(8) === pack.index.count,
    );
    const end = pack.index.ends.get(offset);
    requireObject(end !== undefined && offset < (end || bytes.length - 20));
    const cursor = new ObjectCursor(bytes.subarray(offset, end || bytes.length - 20));
    const first = cursor.byte();
    const type = (first >> 4) & 7;
    let size = first & 15;
    let scale = 16;
    let next = first;
    while (next & 128) {
      next = cursor.byte();
      size += (next & 127) * scale;
      scale *= 128;
      requireObject(size <= objectLimit && Number.isSafeInteger(scale));
    }
    const base = await this.deltaBase(pack, offset, type, cursor, ancestors);
    const data = await inflate(cursor.bytes.subarray(cursor.offset), this.work);
    requireObject(data.length === size, "Git packed object size mismatch");
    if (!base) return this.retain({ type: packedType(type), bytes: data });
    return this.retain({ type: base.type, bytes: await applyDelta(base.bytes, data, this.work) });
  }

  private async deltaBase(
    pack: Pack,
    offset: number,
    type: number,
    cursor: ObjectCursor,
    ancestors: readonly string[],
  ): Promise<GitObject | undefined> {
    if (type === 7) {
      const start = cursor.offset;
      cursor.offset += 20;
      requireObject(cursor.offset <= cursor.bytes.length);
      return this.read(hex(cursor.bytes.subarray(start, cursor.offset)), ancestors);
    }
    if (type !== 6) return undefined;
    let byte = cursor.byte();
    let distance = byte & 127;
    while (byte & 128) {
      byte = cursor.byte();
      distance = (distance + 1) * 128 + (byte & 127);
      requireObject(Number.isSafeInteger(distance));
    }
    requireObject(distance > 0 && distance < offset && pack.index.ends.has(offset - distance));
    return this.unpack(pack, offset - distance, ancestors);
  }

  private retain(object: GitObject): GitObject {
    this.retained += object.bytes.length;
    requireObject(this.retained <= 32 * 1024 * 1024, "Git object cache exceeds 32 MiB");
    return object;
  }

  private async file(path: string): Promise<Uint8Array | undefined> {
    this.work.check();
    const bytes = await this.filesystem.readFile(path);
    this.work.check();
    requireObject(!bytes || bytes.length <= 32 * 1024 * 1024, "Git object file exceeds 32 MiB");
    return bytes;
  }
}

function objectType(value: string): GitObject["type"] {
  requireObject(value === "commit" || value === "tree" || value === "blob" || value === "tag");
  return value;
}
function packedType(value: number): GitObject["type"] {
  if (value === 1) return "commit";
  if (value === 2) return "tree";
  if (value === 3) return "blob";
  requireObject(value === 4, "Unsupported Git packed object type");
  return "tag";
}
