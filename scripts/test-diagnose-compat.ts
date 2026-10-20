import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { journal, parseStat } from "./diagnose-compat.ts";

const script = new URL("./diagnose-compat.ts", import.meta.url).pathname;

type Event = Record<string, unknown>;
function events(directory: string): Event[] {
  try {
    return readFileSync(join(directory, "host.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): Event => JSON.parse(line));
  } catch {
    return [];
  }
}

function alive(pid: number) {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.state !== "Z";
  } catch {
    return false;
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(50);
  }
  assert.fail("control did not become ready within five seconds");
}

function launch(directory: string, command: string, args: string[]) {
  const child = spawn(process.execPath, [script, directory, "--", command].concat(args), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, done, output, errors };
}

function emergencyCleanup(child: ChildProcess, directory: string) {
  const start = events(directory).find((event) => event.kind === "start");
  if (typeof start?.pid === "number") {
    try {
      process.kill(-start.pid, "SIGKILL");
    } catch {}
  }
  child.kill("SIGKILL");
}

function control(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "compat-diag-"));
  const directory = join(root, "trace");
  let child: ChildProcess | undefined;
  t.after(() => {
    if (child) emergencyCleanup(child, directory);
    rmSync(root, { recursive: true });
  });
  return {
    directory,
    launch: (command: string, args: string[]) => {
      const run = launch(directory, command, args);
      child = run.child;
      return run;
    },
  };
}

function assertCleaned(directory: string, pid: number, t: TestContext) {
  assert.ok(!alive(pid));
  assert.deepEqual(events(directory).at(-1)?.remaining, []);
  t.diagnostic(JSON.stringify({ control: "cleanup", pid, live: alive(pid) }));
}

for (const status of [0, 37]) {
  test(`preserves stdout, stderr and status ${status}`, async (t) => {
    const { directory, launch: launchControl } = control(t);
    const run = launchControl(process.execPath, [
      "-e",
      `process.stdout.write('SECRET-output'); process.stderr.write('SECRET-error'); process.exitCode=${status}`,
    ]);
    assert.deepEqual(await run.done, { code: status, signal: null });
    assert.equal(Buffer.concat(run.output).toString(), "SECRET-output");
    assert.equal(Buffer.concat(run.errors).toString(), "SECRET-error");
    assert.ok(!JSON.stringify(events(directory)).includes("SECRET"));
    assert.deepEqual(events(directory).at(-1)?.remaining, []);
  });
}

for (const mode of ["timeout", "SIGTERM", "SIGINT", "SIGKILL-child"]) {
  test(`stalled process telemetry and descendant cleanup on ${mode}`, async (t) => {
    const { directory, launch: launchControl } = control(t);
    const code =
      "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)";
    const command = mode === "timeout" ? "/usr/bin/timeout" : process.execPath;
    const args = mode === "timeout" ? ["2s", process.execPath, "-e", code] : ["-e", code];
    const run = launchControl(command, args);
    await until(() => Buffer.concat(run.output).includes(10));
    const descendant = Number(Buffer.concat(run.output).toString().trim());
    assert.ok(alive(descendant));
    const birth = parseStat(readFileSync(`/proc/${descendant}/stat`, "utf8"))?.startTicks;
    await until(() => events(directory).filter((event) => event.kind === "sample").length >= 2);
    const start = events(directory).find((event) => event.kind === "start");
    assert.equal(typeof start?.pid, "number");
    if (mode === "SIGTERM" || mode === "SIGINT") run.child.kill(mode);
    if (mode === "SIGKILL-child" && typeof start?.pid === "number")
      process.kill(start.pid, "SIGKILL");
    const result = await run.done;
    if (mode === "timeout") assert.deepEqual(result, { code: 124, signal: null });
    else assert.equal(result.signal, mode === "SIGKILL-child" ? "SIGKILL" : mode);
    await until(() => !alive(descendant));
    assert.deepEqual(events(directory).at(-1)?.remaining, []);
    const samples = events(directory).filter((event) => event.kind === "sample");
    assert.ok(
      samples.every((event) => typeof event.gapMs === "number" && Array.isArray(event.processes)),
    );
    assert.ok(JSON.stringify(samples).includes('"sched":['));
    assert.ok(JSON.stringify(samples).includes('"VmRSS":'));
    t.diagnostic(
      JSON.stringify({
        mode,
        descendant,
        birth,
        result,
        samples: samples.length,
        live: alive(descendant),
      }),
    );
  });
}

test("spawn failure remains failure and records cleanup", async (t) => {
  const { directory, launch: launchControl } = control(t);
  const run = launchControl("/does-not-exist/compat-diag", []);
  assert.equal((await run.done).code, 127);
  assert.deepEqual(events(directory).at(-1)?.remaining, []);
});

test("journal rotates at the byte budget and keeps the newest complete events", (t) => {
  const root = mkdtempSync(join(tmpdir(), "compat-diag-"));
  t.after(() => rmSync(root, { recursive: true }));
  const log = journal(root, 512);
  t.after(() => log.close());
  for (let sequence = 0; sequence < 30; sequence++) log.event("control", { sequence });
  assert.ok(statSync(join(root, "host.jsonl")).size <= 512);
  assert.ok(statSync(join(root, "host.previous.jsonl")).size <= 512);
  assert.equal(events(root).at(-1)?.sequence, 29);
});

test("a stopped command has a stopped thread while its observer keeps sampling", async (t) => {
  const { directory, launch: launchControl } = control(t);
  const run = launchControl(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  await until(() => events(directory).some((event) => event.kind === "start"));
  const pid = events(directory).find((event) => event.kind === "start")?.pid;
  assert.equal(typeof pid, "number");
  if (typeof pid !== "number") return;
  process.kill(pid, "SIGSTOP");
  await until(() => JSON.stringify(events(directory)).includes('"state":"T"'));
  process.kill(pid, "SIGCONT");
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.done, { code: null, signal: "SIGTERM" });
  assertCleaned(directory, pid, t);
});

test("a fast parent exit cannot leave a reparented descendant", async (t) => {
  const { directory, launch: launchControl } = control(t);
  const code =
    "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); c.unref(); process.exitCode=19";
  const run = launchControl(process.execPath, ["-e", code]);
  assert.equal((await run.done).code, 19);
  const pid = Number(Buffer.concat(run.output).toString().trim());
  assert.ok(pid > 1);
  assertCleaned(directory, pid, t);
});

test("unavailable diagnostics never skip or replace the command", async (t) => {
  const { directory, launch: launchControl } = control(t);
  writeFileSync(directory, "");
  const run = launchControl(process.execPath, ["-e", "process.exitCode=37"]);
  assert.deepEqual(await run.done, { code: 37, signal: null });
});
