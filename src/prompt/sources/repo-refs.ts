import type { TurnFilesystem } from "../fs";

const decoder = new TextDecoder();
const recordDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const maxPackedBytes = 1024 * 1024;
const maxRefBytes = 4096;
export type RefValue =
  | { readonly kind: "resolved"; readonly commit: string }
  | { readonly kind: "missing" | "unknown" };

export async function readRef(
  filesystem: TurnFilesystem,
  commonDir: string,
  ref: string,
): Promise<string | undefined> {
  const value = await resolveRef(filesystem, commonDir, ref);
  return value.kind === "resolved" ? value.commit : undefined;
}

export async function resolveRef(
  filesystem: TurnFilesystem,
  commonDir: string,
  ref: string,
): Promise<RefValue> {
  const seen = new Set<string>();
  let current = ref;
  for (let depth = 0; depth < 8; depth++) {
    if (!validRef(current) || seen.has(current)) return { kind: "unknown" };
    seen.add(current);
    const path = `${commonDir}/${current}`;
    const entry = await filesystem.lookup(path);
    if (!entry) return packedRef(filesystem, commonDir, (candidate) => candidate === current);
    if (entry.kind !== "file") return { kind: "unknown" };
    const bytes = await filesystem.readFile(path);
    if (!bytes || bytes.length > maxRefBytes) return { kind: "unknown" };
    await filesystem.checkpoint();
    const text = decoder.decode(bytes).trim();
    if (/^[0-9a-f]{40}$/u.test(text)) return { kind: "resolved", commit: text };
    if (!text.startsWith("ref: ")) return { kind: "unknown" };
    current = text.slice(5);
  }
  return { kind: "unknown" };
}

export async function hasPackedReplacement(
  filesystem: TurnFilesystem,
  commonDir: string,
): Promise<boolean> {
  const result = await packedRef(filesystem, commonDir, (ref) => ref.startsWith("refs/replace/"));
  if (result.kind === "unknown") throw new Error("Unknown packed Git refs");
  return result.kind === "resolved";
}

async function packedRef(
  filesystem: TurnFilesystem,
  commonDir: string,
  matches: (ref: string) => boolean,
): Promise<RefValue> {
  const path = `${commonDir}/packed-refs`;
  const entry = await filesystem.lookup(path);
  if (!entry) return { kind: "missing" };
  if (entry.kind !== "file") return { kind: "unknown" };
  const bytes = await filesystem.readFile(path);
  if (!bytes || bytes.length > maxPackedBytes || (bytes.length && bytes[bytes.length - 1] !== 10))
    return { kind: "unknown" };
  await filesystem.checkpoint();
  let result: RefValue = { kind: "missing" };
  let canPeel = false;
  let records = 0;
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(10, offset);
    if (end - offset > maxRefBytes) return { kind: "unknown" };
    if (++records % 64 === 0) await filesystem.checkpoint();
    const line = (offset === 0 ? decoder : recordDecoder).decode(bytes.subarray(offset, end));
    offset = end + 1;
    if (line.startsWith("#")) continue;
    if (canPeel && /^\^[0-9a-f]{40}$/u.test(line)) {
      canPeel = false;
      continue;
    }
    const record = /^([0-9a-f]{40}) (refs\/.*)$/u.exec(line);
    if (!record || record[1] === undefined || record[2] === undefined || !validRef(record[2]))
      return { kind: "unknown" };
    if (matches(record[2])) result = { kind: "resolved", commit: record[1] };
    canPeel = true;
  }
  await filesystem.checkpoint();
  return result;
}

export function validRef(ref: string): boolean {
  return (
    ref.startsWith("refs/") &&
    !Array.from(ref).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
    !/[~^:?*[\\]/u.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  );
}
