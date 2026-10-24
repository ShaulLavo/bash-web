import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function fingerprint() {
  return createHash("sha256")
    .update(readFileSync(process.argv[1]))
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex");
}

export function run(bin, args, timeout) {
  const env = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "BASH_COMPAT", "POSIXLY_CORRECT"])
    delete env[name];
  const result = spawnSync(bin, args, { env, encoding: null, timeout, maxBuffer: 4 * 1024 * 1024 });
  return {
    status: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? result.error?.message ?? ""),
  };
}

export const encode = (result) => ({
  status: result.status,
  signal: result.signal,
  timedOut: result.timedOut,
  stdoutBase64: result.stdout.toString("base64"),
  stderrBase64: result.stderr.toString("base64"),
});

export const decode = (result) => ({
  ...result,
  stdout: Buffer.from(result.stdoutBase64, "base64"),
  stderr: Buffer.from(result.stderrBase64, "base64"),
});
