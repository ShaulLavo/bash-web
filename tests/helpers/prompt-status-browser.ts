import { createRuntime } from "waffle";
import { createShell, SharedBridge, control } from "../../src/index";
import { createPrompt, defaultPromptConfig, WorkBudget } from "../../src/prompt/index";
import { TurnFilesystem } from "../../src/prompt/fs";
import { readRepository } from "../../src/prompt/sources/repo";
import { GitStatusSource } from "../../src/prompt/sources/status";
import type { PromptContext, PromptFilesystem } from "../../src/prompt/types";

const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/fs-worker.js" } });
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function context(root: string): PromptContext {
  return {
    turn: 1,
    cwd: root,
    status: 0,
    pipestatus: [0],
    durationMs: undefined,
    jobs: 0,
    columns: 80,
    rows: 24,
    lineEditor: "bash",
    ps1: "$ ",
    signal: new AbortController().signal,
    variables: new Map([
      ["HOME", "/"],
      ["GIT_DIR", `${root}/.git`],
      ["GIT_WORK_TREE", root],
      ["NO_COLOR", "1"],
    ]),
  };
}
async function prepare(root: string, files: readonly [string, string][]): Promise<void> {
  const directories = new Set(
    files.map(
      ([path]) => `${root}/${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}`,
    ),
  );
  directories.add(root);
  for (const directory of directories) await runtime.filesystem.mkdirp(directory);
  for (const [path, base64] of files) {
    try {
      await runtime.filesystem.writeFile(
        `${root}/${path}`,
        Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
      );
    } catch (cause) {
      throw new Error(`fixture import failed at ${root}/${path}`, { cause });
    }
  }
}
async function measure(root: string, turns = 50) {
  const source = new GitStatusSource((message) => {
    throw new Error(message);
  });
  const samples: number[] = [];
  let hashes = 0;
  const filesystem: PromptFilesystem = {
    lookup: (path) => runtime.filesystem.lookup(path),
    readFile(path) {
      if (/\/f-\d+$/u.test(path)) hashes++;
      return runtime.filesystem.readFile(path);
    },
  };
  for (let turn = 0; turn <= turns; turn++) {
    const start = performance.now();
    const ctx = context(root);
    const fs = new TurnFilesystem(filesystem);
    const repository = await readRepository(fs, ctx);
    if (!repository) throw new Error("repository missing");
    const result = await source.read({
      filesystem: fs,
      repository,
      context: ctx,
      config: defaultPromptConfig.segments.git_status,
      budget: new WorkBudget(ctx.signal, 2000),
      stale() {},
    });
    if (
      result.value.worktree.kind !== "known" ||
      Object.values(result.value.worktree.value).some(Boolean)
    )
      throw new Error("clean fixture status not known clean");
    samples.push(performance.now() - start);
  }
  const cold = samples.shift() ?? 0;
  samples.sort((a, b) => a - b);
  return {
    cold,
    warmMedian: samples[Math.floor(samples.length / 2)],
    warmP95: samples[Math.ceil(samples.length * 0.95) - 1],
    hashes,
    turns,
  };
}
function blockFile(path: string) {
  let release!: () => void;
  let admitted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const filesystem: PromptFilesystem = {
    lookup: (name) => runtime.filesystem.lookup(name),
    async readFile(name) {
      if (name === path) {
        admitted = true;
        await gate;
      }
      return runtime.filesystem.readFile(name);
    },
  };
  return {
    filesystem,
    release,
    get admitted() {
      return admitted;
    },
  };
}
export interface FixtureChoice {
  readonly oid: string;
  readonly staged: number;
  readonly ahead: number;
  readonly behind: number;
  readonly marker: string;
}
type ReadKind = "looseObject" | "pack" | "packIndex" | "index";
interface ReadCount {
  reads: number;
  bytes: number;
}
function observeFilesystem() {
  const counts: Record<ReadKind, ReadCount> = {
    looseObject: { reads: 0, bytes: 0 },
    pack: { reads: 0, bytes: 0 },
    packIndex: { reads: 0, bytes: 0 },
    index: { reads: 0, bytes: 0 },
  };
  const paths = new Set<string>();
  const filesystem: PromptFilesystem = {
    lookup: (path) => runtime.filesystem.lookup(path),
    async readFile(path) {
      const bytes = await runtime.filesystem.readFile(path);
      const kind = readKind(path);
      if (kind && bytes) {
        counts[kind].reads++;
        counts[kind].bytes += bytes.length;
        if (kind !== "index") paths.add(path);
      }
      return bytes;
    },
  };
  return { counts, paths, filesystem };
}
function readKind(path: string): ReadKind | undefined {
  if (path.endsWith("/.git/index")) return "index";
  if (/\/objects\/pack\/.*\.pack$/u.test(path)) return "pack";
  if (/\/objects\/pack\/.*\.idx$/u.test(path)) return "packIndex";
  if (/\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/u.test(path)) return "looseObject";
  return undefined;
}
function productionProvider(filesystem: PromptFilesystem) {
  if (defaultPromptConfig.paintMs !== 15 || defaultPromptConfig.backgroundMs !== 2000)
    throw new Error("production prompt defaults changed");
  return createPrompt({
    filesystem,
    config: { layout: ["git_status"], newline: false, segments: { git_status: { counts: true } } },
  });
}
type Provider = ReturnType<typeof productionProvider>;
const providers = new Map<
  string,
  { provider: Provider; observer: ReturnType<typeof observeFilesystem> }
>();
function beginProduction(root: string) {
  const observer = observeFilesystem();
  providers.set(root, { provider: productionProvider(observer.filesystem), observer });
}
async function selectUpstream(root: string, choice: FixtureChoice) {
  const path = `${root}/.git/refs/heads/upstream`;
  await runtime.filesystem.writeFile(path, `${choice.oid}\n`);
  const readback = await runtime.filesystem.readFile(path);
  if (!readback || decoder.decode(readback).trim() !== choice.oid)
    throw new Error("upstream mutation readback differs");
  return choice.oid;
}
async function production(root: string, choice: FixtureChoice, turn: number) {
  const state = providers.get(root);
  if (!state) throw new Error("production provider not initialized");
  for (const count of Object.values(state.observer.counts)) count.reads = count.bytes = 0;
  state.observer.paths.clear();
  const sample = await completedTurn(state.provider, root, choice.marker, turn);
  const reads = structuredClone(state.observer.counts);
  const objects = reads.looseObject.reads + reads.pack.reads + reads.packIndex.reads;
  if (!objects) throw new Error("completed production sample read no objects");
  return {
    ...sample,
    turn,
    expected: choice,
    reads,
    objectPaths: Array.from(state.observer.paths),
  };
}
async function completedTurn(provider: Provider, root: string, expected: string, turn: number) {
  const live = new AbortController();
  const timer = setTimeout(() => live.abort(new Error("completion watchdog expired")), 10000);
  const observed: string[] = [];
  const start = performance.now();
  let completedAt: number | undefined;
  const observe = (text: string) => {
    observed.push(text);
    if (text === expected && completedAt === undefined) completedAt = performance.now();
  };
  try {
    const first = await provider.render(
      { ...context(root), turn, signal: live.signal },
      {
        signal: live.signal,
        update: observe,
      },
    );
    const firstPaintMs = performance.now() - start;
    observe(first ?? "");
    await until(
      () => completedAt !== undefined || observed.some((text) => text.includes("[…]")),
      live.signal,
    );
    if (observed.some((text) => text.includes("[…]"))) throw new Error("unknown production status");
    if (completedAt === undefined) throw new Error("missing completion");
    return { firstPaintMs, completionMs: completedAt - start, first, marker: expected, observed };
  } finally {
    clearTimeout(timer);
    live.abort();
  }
}
async function validateProduction(root: string, choices: readonly FixtureChoice[]) {
  beginProduction(root);
  const samples = [];
  for (const [index, choice] of choices.entries()) {
    await selectUpstream(root, choice);
    samples.push(await production(root, choice, index + 1));
  }
  providers.delete(root);
  const objectPath = samples[0]?.objectPaths[0];
  if (!objectPath) throw new Error("validation observed no object read to block");
  return { samples, objectPath };
}
async function paint(root: string, path: string, expected: string) {
  const blocked = blockFile(path);
  const provider = createPrompt({
    filesystem: blocked.filesystem,
    config: { segments: { git_status: { counts: true } } },
  });
  const first = new AbortController();
  const timer = setTimeout(() => first.abort(), 10000);
  const samples: number[] = [];
  let final = "";
  try {
    final =
      (await provider.render(context(root), {
        signal: first.signal,
        update(text) {
          final = text;
        },
      })) ?? "";
    await until(() => blocked.admitted, first.signal);
    for (let turn = 2; turn <= 51; turn++) {
      await paintTurn(provider, root, turn, samples);
    }
    blocked.release();
    await until(() => final.includes(expected), first.signal);
  } finally {
    clearTimeout(timer);
    first.abort();
    blocked.release();
  }
  samples.sort((a, b) => a - b);
  return {
    warmMedian: samples[25],
    warmP95: samples[47],
    statusBlocked: blocked.admitted,
    prompts: samples.length,
    path,
    marker: final,
  };
}
async function paintTurn(provider: Provider, root: string, turn: number, samples: number[]) {
  const live = new AbortController();
  try {
    const started = performance.now();
    await provider.render({ ...context(root), turn }, { signal: live.signal, update() {} });
    samples.push(performance.now() - started);
  } finally {
    live.abort();
  }
}
async function until(check: () => boolean, signal?: AbortSignal): Promise<void> {
  const start = performance.now();
  while (!check()) {
    signal?.throwIfAborted();
    if (performance.now() - start > 10000) throw new Error("browser proof timed out");
    await pause(1);
  }
}
async function typing(root: string, mode: "bash" | "zsh", path: string, expected: string) {
  const tracked = `${root}/d-000/f-00000`;
  const original = await runtime.filesystem.readFile(tracked);
  if (!original) throw new Error("tracked control file missing");
  const blocked = blockFile(path);
  const prompt = createPrompt({
    filesystem: blocked.filesystem,
    config: {
      layout: ["git_status", "character"],
      newline: false,
      segments: { git_status: { counts: true } },
    },
  });
  const terminal = new SharedBridge();
  terminal.resize(80, 24);
  const deadline = new AbortController();
  const watchdog = setTimeout(() => deadline.abort(), 10000);
  let shell: Awaited<ReturnType<typeof createShell>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let output = "";
  const pump = () => {
    output += decoder.decode(terminal.drain(), { stream: true });
  };
  try {
    await runtime.filesystem.writeFile(tracked, "changed for live prompt\n");
    shell = await createShell({
      runtime,
      terminal,
      cwd: root,
      lineEditor: { mode },
      signal: deadline.signal,
      wasmUrl: "/programs/shell-engine.wasm",
      workerUrl: "/shell-worker.js",
      prompt,
      env: { HOME: "/", NO_COLOR: "1", GIT_DIR: `${root}/.git`, GIT_WORK_TREE: root, PS1: "$ " },
    });
    timer = setInterval(pump, 1);
    const receipt = await shell.waitForPrompt({ signal: deadline.signal });
    await until(() => blocked.admitted, deadline.signal);
    await send(terminal, "echo abcd\x1b[D\x1b[D");
    await pause(15);
    pump();
    if (!output.includes("echo abcd")) throw new Error("typing did not reach blocked draft");
    if (output.includes(expected)) throw new Error("status completed before gate release");
    blocked.release();
    await until(() => {
      pump();
      return output.includes(expected);
    }, deadline.signal);
    await send(terminal, "Z\r");
    await shell.waitForPrompt({ after: receipt.generation, signal: deadline.signal });
    pump();
    if (!/\r?\nabZcd\r?\n/u.test(output))
      throw new Error(
        `live status redraw lost typed text or caret: ${JSON.stringify(output.slice(-2000))}`,
      );
    return {
      mode,
      path,
      heldReadObserved: blocked.admitted,
      marker: expected,
      typedBufferAndCaretKept: true,
      statusAppearedWithoutKey: true,
    };
  } finally {
    blocked.release();
    deadline.abort();
    clearTimeout(watchdog);
    clearInterval(timer);
    await shell?.dispose();
    await runtime.filesystem.writeFile(tracked, original);
  }
}
async function send(terminal: SharedBridge, text: string): Promise<void> {
  const bytes = encoder.encode(text);
  let offset = 0;
  while (offset < bytes.length) {
    const wake = Atomics.load(terminal.state, control.wake);
    offset += terminal.send(bytes.subarray(offset));
    if (offset < bytes.length) await Atomics.waitAsync(terminal.state, control.wake, wake).value;
  }
}
async function forget(root: string) {
  providers.delete(root);
  await runtime.filesystem.remove(root);
}
const statusProof = {
  prepare,
  forget,
  measure,
  beginProduction,
  selectUpstream,
  production,
  validateProduction,
  paint,
  typing,
  dispose: () => runtime.dispose(),
};
declare global {
  interface Window {
    statusProof: typeof statusProof;
  }
}
window.statusProof = statusProof;
