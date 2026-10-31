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
    files.map(([path]) => `${root}/${path.slice(0, path.lastIndexOf("/"))}`),
  );
  for (const directory of directories) await runtime.filesystem.mkdirp(directory);
  for (const [path, base64] of files)
    await runtime.filesystem.writeFile(
      `${root}/${path}`,
      Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    );
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
async function paint(root: string) {
  const blocked = blockFile(`${root}/d-000/f-00000`);
  const provider = createPrompt({ filesystem: blocked.filesystem });
  const first = new AbortController();
  await provider.render(context(root), { signal: first.signal, update() {} });
  await until(() => blocked.admitted);
  const samples: number[] = [];
  try {
    for (let turn = 2; turn <= 51; turn++) {
      const live = new AbortController();
      const started = performance.now();
      await provider.render({ ...context(root), turn }, { signal: live.signal, update() {} });
      samples.push(performance.now() - started);
      live.abort();
    }
  } finally {
    first.abort();
    blocked.release();
  }
  samples.sort((a, b) => a - b);
  return {
    warmMedian: samples[25],
    warmP95: samples[47],
    statusBlocked: blocked.admitted,
    prompts: samples.length,
  };
}

async function until(check: () => boolean): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > 10000) throw new Error("browser proof timed out");
    await pause(1);
  }
}
async function typing(root: string, mode: "bash" | "zsh") {
  const path = `${root}/d-000/f-00000`;
  await runtime.filesystem.writeFile(path, "changed for live prompt\n");
  const blocked = blockFile(path);
  const prompt = createPrompt({
    filesystem: blocked.filesystem,
    config: { layout: ["git_status", "character"], newline: false, paintMs: 15 },
  });
  const terminal = new SharedBridge();
  terminal.resize(80, 24);
  const shell = await createShell({
    runtime,
    terminal,
    cwd: root,
    lineEditor: { mode },
    wasmUrl: "/programs/shell-engine.wasm",
    workerUrl: "/shell-worker.js",
    prompt,
    env: { HOME: "/", NO_COLOR: "1", GIT_DIR: `${root}/.git`, GIT_WORK_TREE: root, PS1: "$ " },
  });
  let output = "";
  const pump = () => {
    output += decoder.decode(terminal.drain(), { stream: true });
  };
  const timer = setInterval(pump, 1);
  try {
    const receipt = await shell.waitForPrompt();
    await until(() => blocked.admitted);
    await send(terminal, "echo abcd\x1b[D\x1b[D");
    await pause(15);
    blocked.release();
    await until(() => {
      pump();
      return output.includes("[!]") && output.includes("echo abcd");
    });
    await send(terminal, "Z\r");
    await shell.waitForPrompt({ after: receipt.generation });
    pump();
    if (!output.includes("abZcd")) throw new Error("live status redraw lost typed text or caret");
    return { mode, typedBufferAndCaretKept: true, statusAppearedWithoutKey: true };
  } finally {
    blocked.release();
    clearInterval(timer);
    await shell.dispose();
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
const statusProof = { prepare, measure, paint, typing, dispose: () => runtime.dispose() };
declare global {
  interface Window {
    statusProof: typeof statusProof;
  }
}
window.statusProof = statusProof;
