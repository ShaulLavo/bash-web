import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { familyWasiAdapter, familyWasmPath } from "./family-assets.ts";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";

export const verifiedFamilyNames = [
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "mkdir",
  "seq",
  "sort",
  "tail",
  "uniq",
  "wc",
] as const;

export function guestRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function integer(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function text(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([integer(bytes.length), bytes]);
}

function section(kind: number, bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from([kind]), integer(bytes.length), bytes]);
}

function nameSection(symbols: unknown): Buffer {
  const entries = Object.entries(guestRecord(symbols));
  assert.ok(entries.length > 0, "Released guest symbol proof is empty");
  const names = entries.map(([name, index]) => {
    assert.ok(typeof index === "number" && Number.isInteger(index) && index >= 0);
    assert.ok(index <= 0xffff_ffff);
    return Buffer.concat([integer(index), text(name)]);
  });
  const functions = Buffer.concat([integer(names.length)].concat(names));
  return section(0, Buffer.concat([text("name"), section(1, functions)]));
}

export function verifyStrippedWasiGuest(
  path: string,
  proof: unknown,
  sdk?: string,
  filesystemAdapter?: string,
) {
  const selected = guestRecord(proof);
  const bytes = readFileSync(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    selected.sha256,
    "Released guest differs from its symbol proof",
  );
  assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(bytes), "name").length, 0);
  const offset = selected.nameOffset;
  assert.ok(typeof offset === "number" && Number.isInteger(offset));
  assert.ok(offset >= 8 && offset <= bytes.length, "Invalid recovered name section offset");
  const names = nameSection(selected.symbols);
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "family-guest-verifier-"));
  try {
    const named = resolve(scratch, "guest.wasm");
    // Only trusted debug names are restored; the hash-bound executable bytes stay intact.
    writeFileSync(named, Buffer.concat([bytes.subarray(0, offset), names, bytes.subarray(offset)]));
    verifyWasiGuest(named, sdk, filesystemAdapter);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyFamilyGuest(name: string) {
  const sources: unknown = JSON.parse(
    readFileSync(new URL("../sources.lock.json", import.meta.url), "utf8"),
  );
  const programs = guestRecord(guestRecord(sources).wafflePrograms);
  const proof = guestRecord(programs.guests)[name];
  verifyStrippedWasiGuest(familyWasmPath(name), proof, undefined, familyWasiAdapter(name));
}
