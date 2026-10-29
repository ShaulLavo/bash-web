import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type ProcessResult = {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
};

export type EncodedResult = {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutBase64: string;
  stderrBase64: string;
};

export function fingerprint() {
  return createHash("sha256")
    .update(readFileSync(process.argv[1]))
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex");
}

export function run(bin: string, args: string[], timeout: number): ProcessResult {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "BASH_COMPAT", "POSIXLY_CORRECT"])
    delete env[name];
  const result = spawnSync(bin, args, { env, encoding: null, timeout, maxBuffer: 4 * 1024 * 1024 });
  return {
    status: result.status,
    signal: result.signal ?? null,
    timedOut:
      result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? result.error?.message ?? ""),
  };
}

export const encode = (result: ProcessResult): EncodedResult => ({
  status: result.status,
  signal: result.signal,
  timedOut: result.timedOut,
  stdoutBase64: result.stdout.toString("base64"),
  stderrBase64: result.stderr.toString("base64"),
});

export const decode = (result: EncodedResult): ProcessResult => ({
  ...result,
  stdout: Buffer.from(result.stdoutBase64, "base64"),
  stderr: Buffer.from(result.stderrBase64, "base64"),
});

export function parseEncodedResult(value: unknown): EncodedResult {
  if (!isRecord(value)) throw new Error("invalid fixture process result");
  if (
    (typeof value.status !== "number" && value.status !== null) ||
    (typeof value.signal !== "string" && value.signal !== null) ||
    typeof value.timedOut !== "boolean" ||
    typeof value.stdoutBase64 !== "string" ||
    typeof value.stderrBase64 !== "string"
  )
    throw new Error("invalid fixture process result");
  return {
    status: value.status,
    signal: value.signal,
    timedOut: value.timedOut,
    stdoutBase64: value.stdoutBase64,
    stderrBase64: value.stderrBase64,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
