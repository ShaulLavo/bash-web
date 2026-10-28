import { createRuntime, type Runtime } from "waffle";
import { createShell, type Shell } from "../src/shell.ts";
import { installPython } from "../src/utilities/python.ts";
import {
  pythonDirectory,
  pythonEnvironment,
  pythonFiles,
  pythonShellCommand,
  type PythonCase,
} from "../tests/helpers/python-cases.ts";

type Installation = Awaited<ReturnType<typeof installPython>>;
type Sample = { start: number; end: number };
const now = () => performance.now();

type WorkerRecord = { id: number; url: string; process: boolean; stopped: boolean };

function workerRecord(records: Map<Worker, WorkerRecord>, worker: Worker) {
  const record = records.get(worker);
  if (!record) throw new Error("Unobserved Python fixture worker");
  return record;
}

function processRequest(record: WorkerRecord, message: unknown) {
  if (!message || typeof message !== "object" || !("runtimeProcess" in message)) return;
  record.process = true;
}

function observeProcessWorkers() {
  const original = globalThis.Worker;
  const records = new Map<Worker, WorkerRecord>();
  const processURL = new URL("/shell-worker.js", location.href).href;
  let nextId = 0;
  class ObservedWorker extends original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      records.set(this, {
        id: ++nextId,
        url: new URL(url, location.href).href,
        process: false,
        stopped: false,
      });
    }
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      processRequest(workerRecord(records, this), message);
      Reflect.apply(original.prototype.postMessage, this, [message, options]);
    }
    terminate() {
      workerRecord(records, this).stopped = true;
      super.terminate();
    }
  }
  globalThis.Worker = ObservedWorker;
  return {
    snapshot() {
      const live = Array.from(records.values()).filter(
        (record) => !record.stopped && record.url === processURL,
      );
      return {
        pool: live.filter((record) => !record.process),
        processes: live.filter((record) => record.process),
        retired: Array.from(records.values()).filter((record) => record.process && record.stopped),
      };
    },
    restore() {
      globalThis.Worker = original;
      records.clear();
    },
  };
}

function instrumentation() {
  const workers = observeProcessWorkers();
  const compiles: (Sample & { bytes: number })[] = [];
  const originalCompile = WebAssembly.compile;
  WebAssembly.compile = async (...args) => {
    const start = now();
    try {
      return await originalCompile(...args);
    } finally {
      compiles.push({ start, end: now(), bytes: args[0].byteLength });
    }
  };
  return {
    snapshot: () => ({ compiles: compiles.slice() }),
    workers: workers.snapshot,
    restore() {
      WebAssembly.compile = originalCompile;
      workers.restore();
    },
  };
}

async function seed(runtime: Runtime) {
  await runtime.filesystem.mkdirp(pythonDirectory);
  await runtime.filesystem.mkdirp("/home/guest");
  for (const [name, contents] of Object.entries(pythonFiles))
    await runtime.filesystem.writeFile(`${pythonDirectory}/${name}`, contents);
  await runtime.filesystem.drain();
}

async function disposeRuntime(runtime: Runtime, restore: () => void) {
  try {
    await runtime.dispose();
  } finally {
    restore();
  }
}

async function create() {
  const admissions: { stage: string; pid: number; time: number }[] = [];
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
    onProcessAdmission: (event) => {
      admissions.push({ stage: event.stage, pid: event.pid, time: now() });
    },
  });
  let active: Shell | undefined;
  let installation: Installation | undefined;
  const metrics = instrumentation();
  async function close() {
    try {
      await active?.dispose();
      await installation?.dispose();
    } finally {
      await disposeRuntime(runtime, metrics.restore);
    }
  }
  try {
    await seed(runtime);
    const beforeInstall = metrics.snapshot();
    const start = now();
    const installedUtility = await installPython(runtime, {
      workerUrl: "/shell-worker.js",
      wasmUrl: "/python.wasm",
      payloadUrl: "/python-stdlib.json",
    });
    installation = installedUtility;
    const installed = {
      milliseconds: now() - start,
      admissions: admissions.slice(),
      payloadAbsent:
        !(await runtime.filesystem.lookup("/Lib")) &&
        !(await runtime.filesystem.lookup("/cross-build")),
      before: beforeInstall,
      after: metrics.snapshot(),
    };
    return {
      runtime,
      installed,
      metrics,
      admissions,
      setActive: (shell: Shell | undefined) => {
        active = shell;
      },
      release: () => installedUtility.dispose(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof create>>;
let state: Fixture | undefined;
function current() {
  if (!state) throw new Error("Python acceptance fixture is not open");
  return state;
}

async function open() {
  if (state) throw new Error("Python acceptance fixture already open");
  performance.setResourceTimingBufferSize(20000);
  performance.clearResourceTimings();
  state = await create();
  return state.installed;
}

function drainOutput(shell: Shell, chunks: Uint8Array[]) {
  for (;;) {
    const bytes = shell.terminal.drain();
    if (!bytes.length) return;
    chunks.push(bytes);
  }
}

async function runScript(script: string) {
  const fixture = current();
  const start = now();
  const shell = await createShell({
    runtime: fixture.runtime,
    workerUrl: "/shell-worker.js",
    wasmUrl: "/shell-runtime.wasm",
    cwd: pythonDirectory,
    env: pythonEnvironment,
    script: `{ ${script}; } 2>${pythonDirectory}/stderr`,
  });
  fixture.setActive(shell);
  const chunks: Uint8Array[] = [];
  const drain = () => drainOutput(shell, chunks);
  const timer = setInterval(drain, 2);
  try {
    const exit = await shell.done;
    drain();
    const elapsed = now() - start;
    const stdout = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0));
    let offset = 0;
    for (const bytes of chunks) {
      stdout.set(bytes, offset);
      offset += bytes.length;
    }
    return {
      status: exit.code,
      error: exit.error,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(
        await fixture.runtime.filesystem.readFile(`${pythonDirectory}/stderr`),
      ),
      milliseconds: elapsed,
    };
  } finally {
    clearInterval(timer);
    await shell.dispose();
    fixture.setActive(undefined);
  }
}

async function run(example: Pick<PythonCase, "args" | "stdin">) {
  await current().runtime.filesystem.writeFile(`${pythonDirectory}/stdin`, example.stdin);
  await current().runtime.filesystem.drain();
  return runScript(pythonShellCommand(example));
}

function measurement() {
  const fixture = current();
  return {
    ...fixture.metrics.snapshot(),
    workers: fixture.metrics.workers(),
    admissions: fixture.admissions.slice(),
    resources: performance
      .getEntriesByType("resource")
      .filter((entry) => entry instanceof PerformanceResourceTiming)
      .map((entry) => ({
        url: entry.name,
        start: entry.startTime,
        end: entry.responseEnd,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
        transferBytes: entry.transferSize,
      })),
    memory: {
      highWaterBytes: null,
      reason:
        "This run does not collect a completed per-guest linear-memory high-water measurement. Live shell diagnostics are boundary samples, and browser heap/process RSS are not guest memory. The 256 MiB declared limit is a cap only.",
    },
  };
}

async function disposeUtility() {
  const fixture = current();
  await fixture.runtime.filesystem.writeFile("/Lib/caller-owned.txt", "caller data");
  await fixture.runtime.filesystem.drain();
  await fixture.release();
  await fixture.release();
  return {
    markerRemoved: !(await fixture.runtime.filesystem.lookup("/bin/python")),
    payloadRemoved: !(await fixture.runtime.filesystem.lookup("/Lib/os.py")),
    callerFile: new TextDecoder().decode(
      await fixture.runtime.filesystem.readFile("/Lib/caller-owned.txt"),
    ),
    disposed: fixture.runtime.disposed,
    recovery: await runScript('printf "borrowed runtime alive\\n"'),
    missing: await runScript("python --version"),
  };
}

async function disposeUnused() {
  const fixture = current();
  await fixture.release();
  await fixture.release();
  return {
    markerRemoved: !(await fixture.runtime.filesystem.lookup("/bin/python")),
    payloadAbsent:
      !(await fixture.runtime.filesystem.lookup("/Lib")) &&
      !(await fixture.runtime.filesystem.lookup("/cross-build")),
    disposed: fixture.runtime.disposed,
    recovery: await runScript('printf "after unused disposal\\n"'),
  };
}

async function close() {
  const fixture = state;
  state = undefined;
  await fixture?.close();
}

const pythonAcceptance = {
  open,
  run,
  runScript,
  measurement,
  workers: () => current().metrics.workers(),
  disposeUtility,
  disposeUnused,
  close,
};

declare global {
  interface Window {
    pythonAcceptance: typeof pythonAcceptance;
  }
}
if (typeof window !== "undefined") window.pythonAcceptance = pythonAcceptance;
