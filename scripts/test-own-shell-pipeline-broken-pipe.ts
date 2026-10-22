import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

interface Recording {
  id: string;
  script: string;
  status: number;
  stdout: string;
  stderr: string;
}
interface Fixture {
  bash: string;
  cases: Recording[];
}
function fixture(path: string): Fixture {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(value && typeof value === "object" && "bash" in value && "cases" in value);
  assert.equal(value.bash, "5.3.15(1)-release");
  assert.ok(Array.isArray(value.cases));
  return { bash: value.bash, cases: value.cases.map(recording) };
}
function recording(value: unknown): Recording {
  assert.ok(value && typeof value === "object");
  assert.ok("id" in value && typeof value.id === "string");
  assert.ok("script" in value && typeof value.script === "string");
  assert.ok("status" in value && typeof value.status === "number");
  assert.ok("stdout" in value && typeof value.stdout === "string");
  assert.ok("stderr" in value && typeof value.stderr === "string");
  return {
    id: value.id,
    script: value.script,
    status: value.status,
    stdout: value.stdout,
    stderr: value.stderr,
  };
}
const active = new Set<ChildProcess>();
function receipt(event: string, id: string, child: ChildProcess) {
  const destination = process.env.PIPELINE_CLEANUP_RECEIPTS;
  if (destination)
    appendFileSync(destination, `${JSON.stringify({ event, id, pid: child.pid })}\n`);
}
function stop(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    for (const child of active) stop(child);
    process.exit(signal === "SIGTERM" ? 143 : 130);
  });
async function observe(path: string, entry: Recording) {
  const child = spawn(
    process.execPath,
    [resolve("scripts/repro-pipeline-broken-pipe.ts"), path, entry.id],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  active.add(child);
  receipt("spawn", entry.id, child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (bytes: Buffer) => stdout.push(bytes));
  child.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
  const timer = setTimeout(() => stop(child), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `${entry.id}: worker failed or timed out: ${Buffer.concat(stderr)}`);
    const actual: unknown = JSON.parse(Buffer.concat(stdout).toString());
    assert.ok(actual && typeof actual === "object" && "liveWorkers" in actual);
    assert.equal(actual.liveWorkers, 0, "production runner must dispose every worker");
    assert.ok(!("crash" in actual), JSON.stringify(actual));
    assert.deepEqual(recording({ ...actual, script: entry.script }), entry);
  } finally {
    clearTimeout(timer);
    stop(child);
    active.delete(child);
    receipt("stopped", entry.id, child);
  }
}
const path = resolve(
  process.env.PIPELINE_FIXTURE ?? "scripts/fixtures/shell-pipeline-broken-pipe.json",
);
const recordings = fixture(path);
for (const entry of recordings.cases)
  test(`production Waffle typed output: ${entry.id}`, () => observe(path, entry));
