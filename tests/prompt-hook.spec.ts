import { build } from "esbuild";
import { test, expect, type Page } from "./helpers/browser-test";

// Shared page helpers: one runtime, output drained into a string, keys sent in order.
const helpers = `
import { createRuntime } from "waffle";
import { createShell, control, SharedBridge } from "./src/index";
const runtime = createRuntime({filesystem:{workerURL:"/fs-worker.js",mode:"memory"}});
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function terminal() {
  const bridge = new SharedBridge();
  bridge.resize(80, 24);
  return bridge;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 10000) throw new Error("timed out: " + label);
    await sleep(1);
  }
}
function attach(shell) {
  let output = "";
  const pump = () => { output += decoder.decode(shell.terminal.drain(), {stream:true}); };
  const timer = setInterval(pump, 1);
  return {
    text() { pump(); return output; },
    mark() { pump(); return output.length; },
    since(mark) { pump(); return output.slice(mark); },
    stop() { clearInterval(timer); },
  };
}
async function send(shell, text) {
  const input = encoder.encode(text);
  let offset = 0;
  while (offset < input.length) {
    const wake = Atomics.load(shell.terminal.state, control.wake);
    offset += shell.terminal.send(input.subarray(offset));
    if (offset < input.length) await Atomics.waitAsync(shell.terminal.state, control.wake, wake).value;
  }
}
async function enter(shell, text) {
  const after = shell.terminal.readPrompt()?.generation ?? 0n;
  await send(shell, text + "\\r");
  return shell.waitForPrompt({after});
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const p95 = (values) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
`;

async function prove(page: Page, name: string, body: string): Promise<unknown> {
  await page.route(`**/${name}`, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
      body: "<!doctype html><title>Prompt hook</title>",
    }),
  );
  await page.goto(`/${name}`);
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `${helpers}\nwindow.proof = (async () => {\n${body}\n})();`,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await page.addScriptTag({ type: "module", content: compiled.outputFiles[0]!.text });
  await page.waitForFunction(() => "proof" in window);
  return page.evaluate(() => Reflect.get(window, "proof") as Promise<unknown>);
}

test("a prompt provider draws each prompt and redraws it in place", async ({ page }) => {
  const result = await prove(
    page,
    "prompt-hook-fixture",
    `
const contexts = [];
const lives = [];
let mode = "text";
const prepared = [];
const provider = {
  variables: ["FOO", "HOME"],
  prepare(start) { prepared.push(start.cwd); },
  render(context, live) {
    contexts.push({...context, pipestatus: [...context.pipestatus], variables: Object.fromEntries(context.variables), signal: undefined});
    lives.push(live);
    if (mode === "null") return null;
    if (mode === "throw") throw new Error("provider failed");
    if (mode === "reject") return Promise.reject(new Error("provider rejected"));
    if (mode === "never") return new Promise(() => {});
    if (mode === "huge") return "x".repeat(9000);
    return "[" + context.turn + "]> ";
  },
};
const shell = await createShell({runtime, workerUrl:"/shell-worker.js", terminal: terminal(), prompt: provider, env: {PS1: "PS1> "}});
const output = attach(shell);
const checks = {};
try {
  await shell.waitForPrompt();
  await until(() => output.text().includes("[1]> "), "first prompt");
  checks.prepared = prepared;
  await enter(shell, "false | true");
  await enter(shell, "FOO=bar; cd /tmp");
  await enter(shell, "");
  checks.contexts = contexts.map(({turn, cwd, status, pipestatus, durationMs, jobs, columns, lineEditor, ps1, variables}) =>
    ({turn, cwd, status, pipestatus, ran: durationMs !== undefined, jobs, columns, lineEditor, ps1, variables}));

  checks.fallbacks = [];
  for (mode of ["null", "throw", "reject", "never", "huge"]) {
    const mark = output.mark();
    await enter(shell, "");
    await until(() => output.since(mark).includes("PS1> "), mode);
    await enter(shell, "echo ok$((1+1))");
    checks.fallbacks.push(mode + ":" + output.since(mark).includes("ok2"));
  }
  mode = "never";
  let mark = output.mark();
  await enter(shell, "");
  await until(() => output.since(mark).includes("PS1> "), "late answer falls back");
  lives.at(-1).update("late> ");
  await until(() => output.since(mark).includes("late> "), "an update repairs a late answer");
  checks.lateRepaired = true;

  mode = "text";
  await enter(shell, "");
  await send(shell, "echo abcd\\x1b[D\\x1b[D");
  mark = output.mark();
  lives.at(-1).update("NEW> ");
  await until(() => output.since(mark).includes("NEW> echo abcd"), "in-place redraw");
  const live = lives.at(-1);
  mark = output.mark();
  await enter(shell, "Z");
  checks.caretKept = output.since(mark).includes("abZcd");
  checks.afterEnterAborted = live.signal.aborted;
  mark = output.mark();
  live.update("STALE> ");
  await sleep(50);
  checks.noRedrawAfterEnter = !output.since(mark).includes("STALE> ");

  await send(shell, "abc\\x03");
  await until(() => output.text().endsWith("]> "), "prompt after ctrl-c");
  mark = output.mark();
  lives.at(-2).update("INTERRUPTED> ");
  await sleep(50);
  checks.noRedrawAfterInterrupt = !output.since(mark).includes("INTERRUPTED> ");

  mark = output.mark();
  await enter(shell, "{ i=0; while [ $i -lt 3000 ]; do i=$((i+1)); done; echo BG_$((1+1)); } &");
  checks.jobsWhileRunning = contexts.at(-1).jobs;
  const promptAt = output.since(mark).lastIndexOf("]> ");
  await until(() => output.since(mark).includes("BG_2"), "background output");
  checks.backgroundAfterPrompt = output.since(mark).indexOf("BG_2") > promptAt;
  mark = output.mark();
  lives.at(-1).update("GUARDED> ");
  await sleep(50);
  checks.noRedrawOverBackground = !output.since(mark).includes("GUARDED> ");
  await send(shell, "\\x0c");
  await until(() => output.since(mark).includes("GUARDED> "), "ctrl-l shows the newest text");
  checks.ctrlLShowsNewest = true;
  await enter(shell, "wait");
  mark = output.mark();
  await enter(shell, "echo $((6*7))");
  checks.usable = output.since(mark).includes("42");
  checks.renders = contexts.length;
  checks.prompts = Number(shell.terminal.readPrompt().generation);
} finally {
  output.stop();
  await shell.dispose();
}

const plain = await createShell({runtime, workerUrl:"/shell-worker.js", terminal: terminal()});
const plainOutput = attach(plain);
try {
  await plain.waitForPrompt();
  const service = await runtime.processes();
  const mark = plainOutput.mark();
  await service.kill(plain.process.pid, 28);
  await sleep(50);
  checks.strayWinchIgnored = plainOutput.since(mark) === "";
  await enter(plain, "echo alive");
  checks.plainAlive = plainOutput.since(mark).includes("alive");
} finally {
  plainOutput.stop();
  await plain.dispose();
  await runtime.dispose();
}
return checks;
`,
  );
  expect(result).toEqual({
    prepared: ["/home/guest"],
    contexts: [
      {
        turn: 1,
        cwd: "/home/guest",
        status: 0,
        pipestatus: [],
        ran: false,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { HOME: "/home/guest" },
      },
      {
        turn: 2,
        cwd: "/home/guest",
        status: 0,
        pipestatus: [1, 0],
        ran: true,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { HOME: "/home/guest" },
      },
      {
        turn: 3,
        cwd: "/tmp",
        status: 0,
        pipestatus: [0],
        ran: true,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { FOO: "bar", HOME: "/home/guest" },
      },
      {
        turn: 4,
        cwd: "/tmp",
        status: 0,
        pipestatus: [0],
        ran: false,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { FOO: "bar", HOME: "/home/guest" },
      },
    ],
    fallbacks: ["null:true", "throw:true", "reject:true", "never:true", "huge:true"],
    lateRepaired: true,
    caretKept: true,
    afterEnterAborted: true,
    noRedrawAfterEnter: true,
    noRedrawAfterInterrupt: true,
    jobsWhileRunning: 1,
    backgroundAfterPrompt: true,
    noRedrawOverBackground: true,
    ctrlLShowsNewest: true,
    usable: true,
    renders: expect.any(Number),
    prompts: expect.any(Number),
    strayWinchIgnored: true,
    plainAlive: true,
  });
  const { renders, prompts } = result as { renders: number; prompts: number };
  expect(renders).toBe(prompts);
});

test("prompt hook costs", async ({ page }, testInfo) => {
  test.skip(!process.env.BASH_WEB_MEASURE, "set BASH_WEB_MEASURE=1 to measure");
  const result = await prove(
    page,
    "prompt-hook-costs",
    `
const samples = 50;
const summary = (values) => ({median: +median(values).toFixed(3), p95: +p95(values).toFixed(3), samples: values.length});
async function lookups(filesystem) {
  await filesystem.mkdirp("/home/guest/app");
  await filesystem.drain();
  const values = [];
  for (let index = 0; index < 201; index++) {
    const start = performance.now();
    await filesystem.lookup("/home/guest/app");
    if (index) values.push(performance.now() - start);
  }
  return values;
}
const memoryLookups = await lookups(runtime.filesystem);
async function enterToPrompt(options) {
  const shell = await createShell({runtime, workerUrl:"/shell-worker.js", terminal: terminal(), ...options});
  const output = attach(shell);
  try {
    await shell.waitForPrompt();
    for (let index = 0; index < 5; index++) await enter(shell, "");
    const values = [];
    for (let index = 0; index < samples; index++) {
      const start = performance.now();
      await enter(shell, "");
      values.push(performance.now() - start);
    }
    return values;
  } finally {
    output.stop();
    await shell.dispose();
  }
}
const plain = await enterToPrompt({});
const constant = await enterToPrompt({prompt: {variables: [], render: () => "$ "}});
let live;
const shell = await createShell({runtime, workerUrl:"/shell-worker.js", terminal: terminal(), prompt: {variables: [], render(context, current) { live = current; return "$ "; }}});
const output = attach(shell);
const pushes = [];
try {
  await shell.waitForPrompt();
  await send(shell, "echo typed");
  await until(() => output.text().endsWith("echo typed"), "typed");
  for (let index = 0; index < samples + 5; index++) {
    const state = shell.terminal.state;
    const before = Atomics.load(state, control.outputWrite);
    const start = performance.now();
    live.update(index % 2 ? "A> " : "B> ");
    while (Atomics.load(state, control.outputWrite) === before) {
      const wake = Atomics.load(state, control.wake);
      if (Atomics.load(state, control.outputWrite) !== before) break;
      await Atomics.waitAsync(state, control.wake, wake, 2).value;
    }
    if (index >= 5) pushes.push(performance.now() - start);
    await sleep(5);
  }
} finally {
  output.stop();
  await shell.dispose();
  await runtime.dispose();
}
const stored = createRuntime({filesystem:{workerURL:"/fs-worker.js",mode:"fast",name:"prompt-costs-" + Date.now()}});
const fastLookups = await lookups(stored.filesystem);
await stored.dispose();
return {
  lookupMemory: summary(memoryLookups),
  lookupFast: summary(fastLookups),
  enterToPromptWithout: summary(plain),
  enterToPromptWith: summary(constant),
  addedByHook: +(median(constant) - median(plain)).toFixed(3),
  pushToRedraw: summary(pushes),
};
`,
  );
  console.log(JSON.stringify(result, null, 2));
  await testInfo.attach("prompt-hook-costs", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
});
