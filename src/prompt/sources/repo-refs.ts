import type { TurnFilesystem } from "../fs";

const decoder = new TextDecoder();
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
    if (!entry) return packedRef(filesystem, commonDir, current);
    if (entry.kind !== "file") return { kind: "unknown" };
    const bytes = await filesystem.readFile(path);
    if (!bytes) return { kind: "unknown" };
    const text = decoder.decode(bytes).trim();
    if (/^[0-9a-f]{40}$/u.test(text)) return { kind: "resolved", commit: text };
    if (!text.startsWith("ref: ")) return { kind: "unknown" };
    current = text.slice(5);
  }
  return { kind: "unknown" };
}

async function packedRef(
  filesystem: TurnFilesystem,
  commonDir: string,
  ref: string,
): Promise<RefValue> {
  const path = `${commonDir}/packed-refs`;
  const entry = await filesystem.lookup(path);
  if (!entry) return { kind: "missing" };
  if (entry.kind !== "file") return { kind: "unknown" };
  const bytes = await filesystem.readFile(path);
  if (!bytes || (bytes.length && bytes[bytes.length - 1] !== 10)) return { kind: "unknown" };
  const lines = decoder.decode(bytes).split("\n");
  lines.pop();
  let result: RefValue = { kind: "missing" };
  let canPeel = false;
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    if (canPeel && /^\^[0-9a-f]{40}$/u.test(line)) {
      canPeel = false;
      continue;
    }
    const record = /^([0-9a-f]{40}) (refs\/.*)$/u.exec(line);
    if (!record || !validRef(record[2])) return { kind: "unknown" };
    if (record[2] === ref) result = { kind: "resolved", commit: record[1] };
    canPeel = true;
  }
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
