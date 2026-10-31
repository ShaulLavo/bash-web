import { hex } from "./git-bytes";
import type { WorkBudget } from "../live";
import type { IndexEntry, ParsedIndex } from "./index-types";

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function parseIndex(bytes: Uint8Array, budget: WorkBudget): Promise<ParsedIndex> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 32 || decoder.decode(bytes.subarray(0, 4)) !== "DIRC")
    throw new Error("invalid index");
  const version = view.getUint32(4);
  const count = view.getUint32(8);
  if (version < 2 || version > 4) throw new Error("unsupported index version");
  if (count > 20_000 || bytes.length > 16 * 1024 * 1024) throw new Error("index limit");
  const end = bytes.length - 20;
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error("shared index buffer");
  const content = new Uint8Array(bytes.buffer, bytes.byteOffset, end);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", content));
  if (!digest.every((byte, index) => byte === bytes[end + index]))
    throw new Error("index checksum");
  const entries: IndexEntry[] = [];
  let offset = 12;
  let previous: Uint8Array = new Uint8Array();
  for (let index = 0; index < count; index++) {
    if (index % 64 === 0) await budget.checkpoint();
    const parsed = readEntry(bytes, view, offset, end, version, previous);
    entries.push(parsed.entry);
    offset = parsed.offset;
    previous = parsed.path;
  }
  while (offset < end) {
    if (offset + 8 > end) throw new Error("truncated index extension");
    const name = decoder.decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4);
    if (name === "link" || name === "sdir" || !/^[A-Z]/u.test(name))
      throw new Error("unsupported index extension");
    offset += 8 + size;
    if (offset > end) throw new Error("truncated index extension");
    await budget.checkpoint();
  }
  return { entries };
}

function readEntry(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  version: number,
  previous: Uint8Array,
): { entry: IndexEntry; offset: number; path: Uint8Array } {
  if (start + 62 > end) throw new Error("truncated index entry");
  const flags = view.getUint16(start + 60);
  let offset = start + 62;
  let extended = 0;
  if (flags & 0x4000) {
    if (version === 2 || offset + 2 > end) throw new Error("invalid index flags");
    extended = view.getUint16(offset);
    offset += 2;
    if (extended & ~0x6000) throw new Error("unsupported index flags");
  }
  const strip = version === 4 ? readStrip(bytes, offset, end) : { count: 0, offset };
  offset = strip.offset;
  const terminator = bytes.indexOf(0, offset);
  if (terminator < offset || terminator >= end || terminator - offset > 4096)
    throw new Error("invalid index path");
  const prefix = version === 4 ? previous.length - strip.count : 0;
  if (prefix < 0) throw new Error("invalid index prefix");
  const path = new Uint8Array(prefix + terminator - offset);
  if (version === 4) path.set(previous.subarray(0, prefix));
  path.set(bytes.subarray(offset, terminator), version === 4 ? prefix : 0);
  const name = decoder.decode(version === 4 ? path : bytes.subarray(offset, terminator));
  const mode = view.getUint32(start + 24);
  if (![0o100644, 0o100755, 0o120000, 0o160000, 0o040000].includes(mode))
    throw new Error("invalid index mode");
  if (
    !name ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid index path");
  if ((mode & 0o170000) === 0o040000) throw new Error("sparse index");
  return {
    entry: {
      path: name,
      oid: hex(bytes.subarray(start + 40, start + 60)),
      mode,
      stage: (flags >> 12) & 3,
      assumeValid: Boolean(flags & 0x8000),
      skipWorktree: Boolean(extended & 0x4000),
      intentToAdd: Boolean(extended & 0x2000),
      mtimeMs: view.getUint32(start + 8) * 1000 + view.getUint32(start + 12) / 1e6,
    },
    offset: version === 4 ? terminator + 1 : start + Math.ceil((terminator + 1 - start) / 8) * 8,
    path: version === 4 ? path : bytes.subarray(offset, terminator),
  };
}

function readStrip(
  bytes: Uint8Array,
  offset: number,
  end: number,
): { count: number; offset: number } {
  let byte = bytes[offset++];
  let count = byte & 127;
  for (let length = 1; byte & 128; length++) {
    if (offset >= end || length > 4) throw new Error("invalid index prefix");
    byte = bytes[offset++];
    count = (count + 1) * 128 + (byte & 127);
  }
  return { count, offset };
}
