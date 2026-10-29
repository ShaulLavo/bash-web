import { spawnSync } from "node:child_process";

export type ReplayOptions = FuzzOptions & { replays: string[]; cwd?: string };
export type Classification = "MATCH" | "UNSUPPORTED" | "MISMATCH";
export type Counts = Record<Classification, number>;
export type BasicFixture<T, C> = {
  schema: number;
  sourceHash: string;
  seed: number;
  count: number;
  timeoutMs: number;
  bash: string;
  coverage: C;
  cases: RecordedCase<T>[];
};

export type RunOptions = { cwd?: string; timeoutMs: number; interrupted?: boolean };

export type FuzzOptions = {
  seed: number;
  count: number;
  timeoutMs: number;
  replays?: string[];
  cwd?: string;
  interrupted?: boolean;
  explicitSeed?: boolean;
  help?: boolean;
  selfControl?: boolean;
  shell?: string;
  record?: string;
  recordOracle?: string;
  output?: string;
};

type ProcessStatus = {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
};

export type ProcessResult = ProcessStatus & { stdout: Buffer; stderr: Buffer };
export type EncodedResult = ProcessStatus & { stdoutBase64: string; stderrBase64: string };
export type RecordedCase<T> = { case: T; bash: EncodedResult };
export type FuzzFixture<T> = {
  schema: number;
  sourceHash: string;
  sourceHashes: Record<string, string>;
  bash: string;
  oraclePath: string;
  environment: unknown;
  provenance: string;
  count: number;
  timeoutMs: number;
  seed: number;
  coverage: unknown;
  cases: RecordedCase<T>[];
};

export const encode = (result: ProcessResult): EncodedResult => ({
  status: result.status,
  signal: result.signal,
  timedOut: result.timedOut,
  error: result.error,
  stdoutBase64: result.stdout.toString("base64"),
  stderrBase64: result.stderr.toString("base64"),
});

export const decode = (result: EncodedResult): ProcessResult => ({
  ...result,
  stdout: Buffer.from(result.stdoutBase64, "base64"),
  stderr: Buffer.from(result.stderrBase64, "base64"),
});

export function matchesProcessResults(a: ProcessResult, b: ProcessResult): boolean {
  return (
    !a.timedOut &&
    !b.timedOut &&
    !a.error &&
    !b.error &&
    Number.isInteger(a.status) &&
    a.status === b.status &&
    a.signal === null &&
    b.signal === null &&
    a.stdout.equals(b.stdout)
  );
}

export function runSync(
  bin: string,
  script: string,
  options: { cwd?: string; timeoutMs: number },
  setF: boolean,
  outputLimit: number,
): ProcessResult {
  const result = spawnSync(bin, ["-c", setF ? `set -f\n${script}` : script], {
    cwd: options.cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: options.cwd,
      TMPDIR: options.cwd,
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
    },
    input: Buffer.alloc(0),
    encoding: null,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: outputLimit,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    timedOut:
      result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
    error:
      result.error !== undefined && "code" in result.error && typeof result.error.code === "string"
        ? result.error.code
        : null,
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? result.error?.message ?? ""),
  };
}

export function parseEncodedResult(value: unknown, index: number): EncodedResult {
  if (!isRecord(value)) throw new Error("invalid fixture process result at " + index);
  if (
    (typeof value.status !== "number" && value.status !== null) ||
    (typeof value.signal !== "string" && value.signal !== null) ||
    typeof value.timedOut !== "boolean" ||
    (typeof value.error !== "string" && value.error !== null) ||
    typeof value.stdoutBase64 !== "string" ||
    typeof value.stderrBase64 !== "string"
  )
    throw new Error("invalid fixture process result at " + index);
  return {
    status: value.status,
    signal: value.signal,
    timedOut: value.timedOut,
    error: value.error,
    stdoutBase64: value.stdoutBase64,
    stderrBase64: value.stderrBase64,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRecordedCases<T>(value: unknown, expected: readonly T[]): RecordedCase<T>[] {
  if (!Array.isArray(value) || value.length !== expected.length)
    throw new Error("fixture length differs");
  const rawCases: unknown[] = value;
  return expected.map((test, index) => {
    const entry: unknown = rawCases[index];
    if (!isRecord(entry) || JSON.stringify(entry.case) !== JSON.stringify(test))
      throw new Error("fixture case differs at " + index);
    return { case: test, bash: parseEncodedResult(entry.bash, index) };
  });
}

export function validateResultBytes(result: EncodedResult, limit: number, index: number) {
  let bytes = 0;
  for (const key of ["stdoutBase64", "stderrBase64"] as const) {
    const value = result[key];
    if (typeof value !== "string" || Buffer.from(value, "base64").toString("base64") !== value)
      throw new Error("invalid fixture bytes at " + index);
    bytes += Buffer.from(value, "base64").length;
  }
  if (bytes > limit) throw new Error("fixture output limit exceeded at " + index);
}
