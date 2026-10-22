import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

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
