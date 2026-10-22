import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** Run the pinned local GNU Bash once to record an observation; never a CI oracle. */
export function runRecordingBash(script: string, env: NodeJS.ProcessEnv, cwd?: string) {
  const bash = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
    env,
    cwd,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(bash.error, undefined);
  assert.equal(bash.signal, null);
  assert.equal(bash.status, 0, bash.stderr.toString());
  return { status: 0, stdout: bash.stdout, stderr: bash.stderr };
}
