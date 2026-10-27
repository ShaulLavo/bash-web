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

function instrumentation(runtime: Runtime) {
  const writes: Sample[] = [];
  const drains: Sample[] = [];
  const compiles: (Sample & { bytes: number })[] = [];
  const originalWrite = runtime.filesystem.writeFile.bind(runtime.filesystem);
  const originalDrain = runtime.filesystem.drain.bind(runtime.filesystem);
  const originalCompile = WebAssembly.compile;
  runtime.filesystem.writeFile = async (...args) => {
    const start = now();
    try {
      return await originalWrite(...args);
    } finally {
      writes.push({ start, end: now() });
    }
  };
  runtime.filesystem.drain = async () => {
    const start = now();
    try {
      return await originalDrain();
    } finally {
      drains.push({ start, end: now() });
    }
  };
  WebAssembly.compile = async (...args) => {
    const start = now();
    try {
      return await originalCompile(...args);
    } finally {
      compiles.push({ start, end: now(), bytes: args[0].byteLength });
    }
  };
  return {
    snapshot: () => ({
      writes: writes.slice(),
      drains: drains.slice(),
      compiles: compiles.slice(),
    }),
    restore() {
      runtime.filesystem.writeFile = originalWrite;
      runtime.filesystem.drain = originalDrain;
      WebAssembly.compile = originalCompile;
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
  const metrics = instrumentation(runtime);
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
