import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const intervalMs = 1000;
const segmentBytes = 16 * 1024 * 1024;
const maxProcesses = 64;
const maxThreads = 64;

type Stat = {
  pid: number;
  state: string;
  parent: number;
  group: number;
  session: number;
  minorFaults: number;
  majorFaults: number;
  userTicks: number;
  systemTicks: number;
  startTicks: number;
  rssPages: number;
  cpu: number;
};

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function parseStat(text: string): Stat | null {
  const end = text.lastIndexOf(") ");
  if (end < 0) return null;
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const values = [0, 1, 2, 3, 7, 9, 11, 12, 19, 21, 36].map((index) => Number(fields[index]));
  if (fields.length < 37 || values.slice(1).some((value) => !Number.isFinite(value))) return null;
  return {
    pid: Number(text.slice(0, text.indexOf(" "))),
    state: fields[0],
    parent: values[1],
    group: values[2],
    session: values[3],
    minorFaults: values[4],
    majorFaults: values[5],
    userTicks: values[6],
    systemTicks: values[7],
    startTicks: values[8],
    rssPages: values[9],
    cpu: values[10],
  };
}

function processes(session: number): Stat[] {
  const rows = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  return rows
    .map((pid) => parseStat(read(`/proc/${pid}/stat`)))
    .filter((stat): stat is Stat => stat !== null && stat.session === session);
}

function numericLines(path: string, keys: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of read(path).split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match && keys.includes(match[1])) result[match[1]] = Number(match[2]);
  }
  return result;
}

function threadSample(pid: number, tid: string) {
  const path = `/proc/${pid}/task/${tid}`;
  const stat = parseStat(read(`${path}/stat`));
  if (!stat) return null;
  const sched = read(`${path}/schedstat`).trim().split(/\s+/).map(Number);
  const wchan = read(`${path}/wchan`).trim();
  return {
    tid: stat.pid,
    startTicks: stat.startTicks,
    state: stat.state,
    userTicks: stat.userTicks,
    systemTicks: stat.systemTicks,
    cpu: stat.cpu,
    minorFaults: stat.minorFaults,
    majorFaults: stat.majorFaults,
    sched: sched.length === 3 && sched.every(Number.isFinite) ? sched : null,
    wchan: /^[a-zA-Z0-9_]{1,80}$/.test(wchan) ? wchan : null,
    switches: numericLines(`${path}/status`, [
      "voluntary_ctxt_switches",
      "nonvoluntary_ctxt_switches",
    ]),
  };
}

function processSample(stat: Stat) {
  let tids: string[] = [];
  try {
    tids = readdirSync(`/proc/${stat.pid}/task`);
  } catch {
    /* A process can exit between the session scan and task scan. */
  }
  return {
    ...stat,
    memory: numericLines(`/proc/${stat.pid}/status`, ["VmRSS", "VmHWM", "VmSwap", "Threads"]),
    output: numericLines(`/proc/${stat.pid}/io`, ["wchar", "syscw"]),
    threadsOmitted: Math.max(0, tids.length - maxThreads),
    threads: tids
      .slice(0, maxThreads)
      .map((tid) => threadSample(stat.pid, tid))
      .filter((row) => row !== null),
  };
}

function hostSample() {
  return {
    memory: numericLines("/proc/meminfo", ["MemAvailable", "SwapFree"]),
    cpu: read("/proc/stat")
      .split("\n")
      .filter((line) => /^(cpu |procs_running |procs_blocked )/.test(line))
      .map((line) => line.trim().split(/\s+/).slice(1).map(Number)),
    pressure: ["cpu", "memory", "io"].map((kind) => ({
      kind,
      totals: Array.from(read(`/proc/pressure/${kind}`).matchAll(/total=(\d+)/g), (match) =>
        Number(match[1]),
      ),
    })),
  };
}

export function journal(directory: string, limit = segmentBytes) {
  const path = join(directory, "host.jsonl");
  let fd: number | undefined;
  let bytes = 0;
  let writable = true;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(path, "wx", 0o600);
  } catch {
    writable = false;
  }
  const start = performance.now();
  function append(kind: string, data: object) {
    if (fd === undefined) return;
    const line =
      JSON.stringify({
        kind,
        utc: new Date().toISOString(),
        ms: performance.now() - start,
        ...data,
      }) + "\n";
    const size = Buffer.byteLength(line);
    if (size > limit) return;
    if (bytes + size > limit) {
      closeSync(fd);
      renameSync(path, join(directory, "host.previous.jsonl"));
      fd = openSync(path, "w", 0o600);
      bytes = 0;
    }
    writeSync(fd, line);
    bytes += size;
  }
  function event(kind: string, data: object) {
    if (!writable) return;
    try {
      append(kind, data);
    } catch {
      writable = false;
    }
  }
  return {
    event,
    close: () => {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {}
    },
  };
}

function signalSession(session: number, signal: NodeJS.Signals) {
  // The detached command owns this session, including reparented processes.
  for (const stat of processes(session)) {
    if (parseStat(read(`/proc/${stat.pid}/stat`))?.startTicks !== stat.startTicks) continue;
    try {
      process.kill(stat.pid, signal);
    } catch {}
  }
}

async function cleanup(session: number) {
  signalSession(session, "SIGCONT");
  signalSession(session, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  signalSession(session, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
  return processes(session)
    .filter((stat) => stat.state !== "Z")
    .map((stat) => stat.pid);
}

export async function diagnose(directory: string, command: string, args: readonly string[]) {
  const log = journal(directory);
  let session: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    log.event("signal", { signal });
    if (session === undefined) return;
    try {
      signalSession(session, signal);
    } catch {
      log.event("signal-unavailable", { signal });
    }
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let last = performance.now();
  const collect = () => {
    if (session === undefined) return;
    const now = performance.now();
    const members = processes(session);
    const rows = members.slice(0, maxProcesses).map(processSample);
    const host = hostSample();
    log.event("sample", {
      sampleDurationMs: performance.now() - now,
      gapMs: now - last,
      observerCpu: process.cpuUsage(),
      observerRss: process.memoryUsage().rss,
      host,
      processesOmitted: Math.max(0, members.length - maxProcesses),
      processes: rows,
    });
    last = now;
  };
  const sample = () => {
    try {
      collect();
    } catch {
      log.event("sample-unavailable", {});
    }
  };
  try {
    const child = spawn(command, args, { detached: true, stdio: "inherit" });
    session = child.pid;
    const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", () => resolve({ code: 127, signal: null }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    log.event("start", {
      pid: session ?? null,
      intervalMs,
      segmentBytes,
      maxProcesses,
      maxThreads,
    });
    sample();
    timer = setInterval(sample, intervalMs);
    const result = await outcome;
    clearInterval(timer);
    log.event("exit", result);
    return result;
  } finally {
    if (timer) clearInterval(timer);
    let remaining: number[] | null = null;
    try {
      remaining = session === undefined ? [] : await cleanup(session);
    } catch {}
    log.event("cleanup", { remaining });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    log.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, separator, command, ...args] = process.argv.slice(2);
  if (process.platform !== "linux" || !directory || separator !== "--" || !command)
    throw new Error(
      "Usage on Linux: node scripts/diagnose-compat.ts OUTPUT_DIRECTORY -- COMMAND [ARG...]",
    );
  const result = await diagnose(directory, command, args);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
