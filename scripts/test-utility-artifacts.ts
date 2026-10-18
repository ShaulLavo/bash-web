import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { stageUtilityArtifacts, utilityNames, writeUtilityArtifacts } from "./utility-artifacts.ts";

const root = resolve(import.meta.dirname, "..");
const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 1, 1, 1, 128, 32);

function fixture(run: (source: string, output: string, target: string) => void) {
  mkdirSync(resolve(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".build/utility-artifacts-test-"));
  const source = resolve(scratch, "source");
  const output = resolve(scratch, "artifact");
  const target = resolve(scratch, "consumer");
  mkdirSync(source);
  for (const name of utilityNames) writeFileSync(resolve(source, `${name}.wasm`), wasm);
  try {
    run(source, output, target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("utility handoff verifies exact source, guest hashes and final memory before staging", () => {
  fixture((source, output, target) => {
    writeUtilityArtifacts(root, source, output);
    stageUtilityArtifacts(root, output, target);
    for (const name of utilityNames)
      assert.deepEqual(readFileSync(resolve(target, `${name}.wasm`)), Buffer.from(wasm));
  });
});

test("a mismatched source receipt is rejected before replacing consumer output", () => {
  fixture((source, output, target) => {
    writeUtilityArtifacts(root, source, output);
    const receipt = resolve(output, "source-sha256.txt");
    writeFileSync(
      receipt,
      readFileSync(receipt, "utf8").replace(/source [a-f0-9]{40}/, `source ${"0".repeat(40)}`),
    );
    assert.throws(() => stageUtilityArtifacts(root, output, target), /exact source/);
  });
});

test("a tampered but valid guest is rejected by its hash", () => {
  fixture((source, output, target) => {
    writeUtilityArtifacts(root, source, output);
    writeFileSync(resolve(output, "cat.wasm"), Buffer.concat([wasm, Uint8Array.of(0, 1, 0)]));
    assert.throws(() => stageUtilityArtifacts(root, output, target), /every verified guest hash/);
  });
});

test("a missing guest or invalid memory contract cannot produce a receipt", () => {
  fixture((source, output) => {
    rmSync(resolve(source, "seq.wasm"));
    assert.throws(() => writeUtilityArtifacts(root, source, output), /ENOENT/);
    writeFileSync(resolve(source, "seq.wasm"), Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    assert.throws(() => writeUtilityArtifacts(root, source, output), /no capped guest memory/);
  });
});
