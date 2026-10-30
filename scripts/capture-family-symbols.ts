import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { familyProgramNames, familyWasmPath, familyWasiAdapter } from "./family-assets.ts";
import { guestRecord } from "./verify-family-guests.ts";
import { functionNames, verifyWasiGuest } from "./verify-wasi-guests.ts";

const json = (path: string) => guestRecord(JSON.parse(readFileSync(path, "utf8")));
const identity = (bytes: Uint8Array) => ({
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

function unsigned(bytes: Uint8Array, start: number) {
  let value = 0;
  let shift = 0;
  for (let next = start; next < start + 5; next++) {
    const byte = bytes[next];
    assert.notEqual(byte, undefined, "Truncated section length");
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return { value, next: next + 1 };
    shift += 7;
  }
  throw new Error("Oversized section length");
}

function customName(bytes: Uint8Array, start: number) {
  const size = unsigned(bytes, start);
  return new TextDecoder().decode(bytes.subarray(size.next, size.next + size.value));
}

// Preserve every encoded byte except complete name custom sections.
export function stripNames(bytes: Uint8Array) {
  const retained = [bytes.subarray(0, 8)];
  let offset = 8;
  let kept = 8;
  let nameOffset: number | undefined;
  while (offset < bytes.length) {
    const start = offset;
    const kind = bytes[offset++];
    const size = unsigned(bytes, offset);
    offset = size.next + size.value;
    assert.ok(offset <= bytes.length, "Truncated section body");
    if (kind === 0 && customName(bytes, size.next) === "name") {
      nameOffset ??= kept;
      continue;
    }
    retained.push(bytes.subarray(start, offset));
    kept += offset - start;
  }
  assert.ok(nameOffset !== undefined, "Named guest has no name section");
  return { bytes: Buffer.concat(retained), nameOffset };
}

function capture(name: string, directory: string, revision: string) {
  const path = familyWasmPath(name);
  const final = readFileSync(path);
  const receipt = json(resolve(dirname(path), `${name}-program.json`));
  assert.equal(receipt.operation, "optimize-and-strip-program");
  assert.equal(guestRecord(receipt.transformer).commit, revision);
  assert.ok(Array.isArray(receipt.operations) && receipt.operations.length === 2);
  const optimized = guestRecord(receipt.operations[0]);
  const stripped = guestRecord(receipt.operations[1]);
  assert.equal(optimized.stage, "wasm-opt-before-name-strip");
  assert.equal(stripped.operation, "strip-wasm-name-sections");
  const namedPath = resolve(directory, `${name}-named.wasm`);
  const named = readFileSync(namedPath);
  const namedIdentity = identity(named);
  const finalIdentity = identity(final);
  assert.deepEqual(optimized.output, namedIdentity);
  assert.deepEqual(stripped.input, namedIdentity);
  assert.deepEqual(stripped.output, finalIdentity);
  assert.deepEqual(receipt.output, finalIdentity);
  const module = new WebAssembly.Module(named);
  const recovered = stripNames(named);
  assert.deepEqual(recovered.bytes, final, `${name}: name stripping changed executable bytes`);
  verifyWasiGuest(namedPath, undefined, familyWasiAdapter(name));
  const symbols = Array.from(functionNames(module))
    .filter(([symbol]) => /^(?:__wasi|waffle_program_support::runtime::wasi::)/.test(symbol))
    .sort((left, right) => left[1] - right[1]);
  assert.ok(symbols.length > 0, `${name}: missing verification symbols`);
  return {
    sha256: finalIdentity.sha256,
    namedSha256: namedIdentity.sha256,
    nameOffset: recovered.nameOffset,
    symbols: Object.fromEntries(symbols),
  };
}

function main() {
  const [directory, manifestPath, output] = process.argv.slice(2);
  assert.ok(
    directory && manifestPath && output,
    "Use <named directory> <release manifest> <output>",
  );
  const release = json(manifestPath);
  assert.equal(release.schema, "waffle-program-release/1");
  assert.equal(release.tagState, "tagged");
  assert.equal(release.dirty, false);
  assert.ok(
    typeof release.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(release.sourceCommit),
  );
  const revision = release.sourceCommit;
  const runtime = guestRecord(release.runtime);
  const sources = json(resolve(import.meta.dirname, "../sources.lock.json"));
  assert.equal(runtime.url, guestRecord(sources.waffle).specifier);
  assert.equal(runtime.sha256, guestRecord(sources.waffle).archiveSha256);
  const proof = {
    version: release.version,
    revision,
    provenance:
      "Function indices from the exact named optimized outputs in the published derivations. Capture verifies the named hashes, reruns scanner and memory checks, and proves that removing only name custom sections yields the released bytes exactly. Final SHA-256 binds these symbols to unchanged executable bytes. Historical local guest provenance is unchanged.",
    guests: Object.fromEntries(
      familyProgramNames.map((name) => [name, capture(name, directory, revision)]),
    ),
  };
  writeFileSync(output, JSON.stringify(proof, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
