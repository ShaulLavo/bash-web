import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WaffleCaseResult } from "./waffle-compat.ts";

type Recorded = { script: string; status: number; stdoutBase64: string };
type Observation = { status: number; stdout: Buffer };

/** Committed GNU Bash observations for hosts whose Bash is not the pinned oracle. */
export function recordedBash(
  fixturePath: URL,
  recordPath: string | undefined,
  version: RegExp,
  liveVersion: () => string,
) {
  const fixture: { bash: string; cases: Recorded[] } = recordPath
    ? { bash: liveVersion(), cases: [] }
    : JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.match(fixture.bash, version);
  const cases = new Map(fixture.cases.map((entry) => [entry.script, entry]));
  const recorded: Recorded[] = [];
  return {
    fixture,
    cases,
    recording: Boolean(recordPath),
    replay(script: string): Observation {
      const entry = cases.get(script);
      assert.ok(entry, `missing recorded Bash observation: ${script}`);
      return { status: entry.status, stdout: Buffer.from(entry.stdoutBase64, "base64") };
    },
    record(script: string, live: Observation) {
      recorded.push({ script, status: live.status, stdoutBase64: live.stdout.toString("base64") });
    },
    save() {
      if (!recordPath) return;
      const result = { schema: 1, bash: fixture.bash, cases: recorded };
      writeFileSync(recordPath, JSON.stringify(result, null, 2) + "\n");
    },
  };
}

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

export function recordingEnvironment() {
  return { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" };
}

type ReaderCase = { script: string; status: number; stdout: string; stderr: string };

export function recordedReaderCases(options: {
  fixturePath: URL;
  fixture: { bash: string; cases: ReaderCase[] };
  scripts: readonly string[];
  env: NodeJS.ProcessEnv;
  record: boolean;
}): ReaderCase[] {
  let fixture = options.fixture;
  if (options.record) {
    const version = spawnSync("/usr/bin/bash", ["-c", 'printf %s "$BASH_VERSION"']);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.toString(), "5.3.15(1)-release");
    fixture = {
      bash: version.stdout.toString(),
      cases: options.scripts.map((script) => recordReader(script, options.env)),
    };
    writeFileSync(options.fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  }
  assert.equal(fixture.bash, "5.3.15(1)-release");
  assert.deepEqual(
    fixture.cases.map((entry) => entry.script),
    options.scripts,
  );
  return fixture.cases;
}

function recordReader(script: string, env: NodeJS.ProcessEnv): ReaderCase {
  const cwd = mkdtempSync(join(tmpdir(), "bash-web-record-"));
  try {
    const result = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
      cwd,
      env,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.ok(result.status !== null);
    return {
      script,
      status: result.status,
      stdout: result.stdout.toString("base64"),
      stderr: result.stderr.toString("base64"),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function assertReaderOutput(
  actual: WaffleCaseResult,
  expected: Pick<ReaderCase, "status" | "stdout">,
) {
  assert.equal(actual.crash, undefined);
  assert.equal(actual.outputLimit, undefined);
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.stdout, Buffer.from(expected.stdout, "base64"));
}
