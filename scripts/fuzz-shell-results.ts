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
