import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProcessResult } from "../../fuzz-shell-results.ts";

export function assertFuzzSourceIdentity(
  source: {
    sourceFiles: readonly string[];
    sourceHashes(): Record<string, string>;
    fingerprint(): string;
  },
  generator: string,
): void {
  const files = [
    generator,
    "fuzz-shell-control-flow.ts",
    "fuzz-shell-results.ts",
    "shell-process-group.ts",
  ];
  const hashes = source.sourceHashes();
  assert.deepEqual(source.sourceFiles, files);
  assert.deepEqual(Object.keys(hashes), files);
  for (const name of files) {
    const bytes = readFileSync(new URL(`../../${name}`, import.meta.url));
    assert.equal(hashes[name], createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(
    source.fingerprint(),
    createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
  );
}

export function observation(patch: Partial<ProcessResult> = {}): ProcessResult {
  return {
    status: 0,
    signal: null,
    timedOut: false,
    error: null,
    stdout: Buffer.from("ok\n"),
    stderr: Buffer.alloc(0),
    ...patch,
  };
}

export function recordedCases<T>(cases: readonly T[]) {
  return cases.map((item) => ({
    case: item,
    bash: {
      status: 0,
      signal: null,
      timedOut: false,
      error: null,
      stdoutBase64: "",
      stderrBase64: "",
    },
  }));
}

export function syntheticFixture<T>(source: {
  generateCases(seed: number, count: number): T[];
  fingerprint(): string;
  sourceHashes(): Record<string, string>;
  defaultTimeoutMs: number;
  environment: unknown;
  coverage(cases: T[]): unknown;
}): import("../../fuzz-shell-results.ts").FuzzFixture<T> {
  const cases = source.generateCases(1, 0);
  return {
    schema: 1,
    sourceHash: source.fingerprint(),
    sourceHashes: source.sourceHashes(),
    timeoutMs: source.defaultTimeoutMs,
    environment: source.environment,
    coverage: source.coverage(cases),
    seed: 1,
    count: 0,
    bash: "GNU bash, version 5.3.15(1)-release (test)",
    oraclePath: "/usr/bin/bash",
    provenance: "oracle-only",
    cases: recordedCases(cases),
  };
}
