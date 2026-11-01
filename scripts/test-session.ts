import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import type { Runtime } from "waffle";
import type { PromptProvider } from "bash-web";
import type { BrowserSession, SessionOptions, SessionState } from "bash-web/session";
import type { Shell, ShellOptions, RuntimeExit } from "../src/shell.ts";
import type { SharedBridge } from "../src/bridge.ts";
import type { waitForPrompt } from "../src/shell-prompt.ts";
import type { runtimeSnapshot } from "../src/runtime/diagnostics.ts";

// Only shell admission is replaced. The public session, rings, receipts, newline
// discipline, scheduling and cancellation execute unchanged in this bundle.
const compiled = await build({
  stdin: {
    contents: `export { BrowserSession } from "bash-web/session";
      export { setCreateShell } from "session-test-shell";
      export { control } from "./src/bridge";
      export { waitForPrompt } from "./src/shell-prompt";
      export { runtimeSnapshot } from "./src/runtime/diagnostics";`,
    resolveDir: process.cwd(),
    sourcefile: "session-contract.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  plugins: [
    {
      name: "session-admission",
      setup(builder) {
        builder.onResolve({ filter: /^(\.\/index|session-test-shell)$/ }, (args) => {
          if (args.path !== "session-test-shell" && !args.importer.endsWith("/src/session.ts"))
            return;
          return { path: "session-test-shell", namespace: "fixture" };
        });
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export { SharedBridge } from "./src/bridge";
          export { TerminalNewlines } from "./src/shell-terminal-output";
          export function runtimeSnapshot() { return {}; }
          let factory;
          export function setCreateShell(next) { factory = next; }
          export function createShell(options) { return factory(options); }`,
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const api: {
  BrowserSession: typeof BrowserSession;
  control: typeof import("../src/bridge.ts").control;
  waitForPrompt: typeof waitForPrompt;
  runtimeSnapshot: typeof runtimeSnapshot;
  setCreateShell(factory: (options: ShellOptions) => Promise<Shell>): void;
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

test("the public session entry typechecks for strict consumers", (context) => {
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(resolve(root, ".scratch"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".scratch/session-consumer-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  mkdirSync(resolve(scratch, "node_modules"), { recursive: true });
  symlinkSync(root, resolve(scratch, "node_modules/bash-web"), "dir");
  writeFileSync(resolve(scratch, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    resolve(scratch, "tsconfig.json"),
    JSON.stringify({
      extends: resolve(root, "tsconfig.json"),
      compilerOptions: { noUncheckedIndexedAccess: true },
      include: ["index.ts"],
    }),
  );
  writeFileSync(
    resolve(scratch, "index.ts"),
    'import type { BrowserSession, SessionOptions } from "bash-web/session";\n' +
      "export type SessionFactory = (options: SessionOptions) => Promise<BrowserSession>;\n",
  );
  const result = spawnSync(resolve(root, "node_modules/.bin/tsc"), ["--project", scratch], {
    cwd: scratch,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function fixture(
  context: TestContext,
  overrides: Partial<SessionOptions> = {},
  initialPrompt = true,
) {
  const isolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  let bridge!: SharedBridge;
  const states: SessionState[] = [];
  const details: (string | undefined)[] = [];
  const output: number[] = [];
  const owner = { disposals: 0 };
  const runtime = {
    filesystem: { state: { status: "ready" } },
    async dispose() {
      owner.disposals++;
    },
  } as unknown as Runtime;
  let disposals = 0;
  let interrupts = 0;
  let admitted: ShellOptions | undefined;
  let finish!: (exit: RuntimeExit) => void;
  const done = new Promise<RuntimeExit>((resolve) => {
    finish = resolve;
  });
  api.setCreateShell(async (options) => {
    admitted = options;
    // Attach to the exact session buffer rather than creating a second bridge owner.
    const terminal = options.terminal;
    assert.ok(terminal);
    bridge = terminal;
    if (initialPrompt) bridge.publishPrompt(0);
    return {
      terminal,
      process: { pid: 1, wasmBytes: 42, done, signal() {}, async dispose() {} },
      done,
      waitForPrompt: (options) => api.waitForPrompt(bridge, options),
      interrupt() {
        interrupts++;
      },
      async dispose() {
        disposals++;
      },
      diagnostics: () => api.runtimeSnapshot(runtime),
    };
  });
  const options: SessionOptions = {
    runtime,
    cols: 80,
    rows: 24,
    onOutput(bytes) {
      for (const byte of bytes) output.push(byte);
    },
    onState(state, detail) {
      states.push(state);
      details.push(detail);
    },
    ...overrides,
  };
  const starting = api.BrowserSession.create(options);
  context.after(async () => {
    const session = await starting.catch(() => undefined);
    await session?.dispose();
    bridge.close();
    if (isolation) Object.defineProperty(globalThis, "crossOriginIsolated", isolation);
    else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  });
  return {
    bridge,
    runtime,
    starting,
    states,
    details,
    output,
    finish,
    owner,
    admitted: () => admitted,
    disposals: () => disposals,
    interrupts: () => interrupts,
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
}
function phase(bridge: SharedBridge, value: number): void {
  Atomics.store(bridge.state, api.control.phase, value);
  bridge.signal();
}

test("session creation waits for a real prompt and forwards interactive shell options", async (context) => {
  const lineEditor = { mode: "zsh" } as const;
  const env = { PS1: "$ " };
  const prompt: PromptProvider = { variables: ["HOME"], render: () => "provider> " };
  const wasmUrl = new URL("https://shell.example/shell.wasm");
  const workerUrl = new URL("https://shell.example/worker.js");
  const f = fixture(
    context,
    { lineEditor, env, prompt, cwd: "/project", wasmUrl, workerUrl },
    false,
  );
  let resolved = false;
  void f.starting.then(() => {
    resolved = true;
  });
  await turn();
  assert.equal(resolved, false);
  assert.deepEqual(f.states, ["starting"]);
  f.bridge.publishPrompt(7);
  const session = await f.starting;
  assert.deepEqual(session.lastPrompt, { generation: 1n, status: 7 });
  assert.equal(session.state, "ready");
  assert.equal(session.lastExit, 7);
  assert.equal(session.metrics.wasmBytes, 42);
  const admitted = f.admitted();
  assert.equal(admitted?.lineEditor, lineEditor);
  assert.equal(admitted?.prompt, prompt);
  assert.equal(admitted?.env, env);
  assert.equal(admitted?.cwd, "/project");
  assert.equal(admitted?.wasmUrl, wasmUrl);
  assert.equal(admitted?.workerUrl, workerUrl);
  assert.equal(admitted?.runtime, f.runtime);
});

test("ready, running and exited follow the guest while the runtime stays borrowed", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  phase(f.bridge, 2);
  await turn();
  assert.equal(session.running, true);
  f.bridge.publishPrompt(1);
  await turn();
  assert.equal(session.lastExit, 1);
  assert.equal(session.lastPrompt?.generation, 2n);
  phase(f.bridge, 3);
  await turn();
  assert.deepEqual(f.states, ["starting", "ready", "running", "ready", "exited"]);
  assert.equal(session.state, "exited");
  assert.equal(f.disposals(), 1);
  await session.dispose();
  assert.equal(f.disposals(), 1);
  assert.equal(f.owner.disposals, 0);
});

test("failure drains final output before reporting its detail and disposes once", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  f.finish({ code: 1, error: "Guest crashed" });
  await Promise.resolve();
  f.bridge.tryWrite([new Uint8Array(100000).fill(65)]);
  phase(f.bridge, 4);
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(f.output.length, 100000);
  assert.equal(session.state, "failed");
  assert.equal(f.details.at(-1), "Guest crashed");
  await session.dispose();
  assert.equal(f.disposals(), 1);
});

test("startup without a prompt times out, reports failed and disposes its admitted shell", async (context) => {
  const f = fixture(context, { startupTimeoutMs: 5 }, false);
  await assert.rejects(f.starting, /Shell startup exceeded/);
  assert.deepEqual(f.states, ["starting", "failed"]);
  assert.equal(f.disposals(), 1);
});

test("input is copied, chunked at 64 KiB and resumed when the guest drains", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  const input = Uint8Array.from({ length: 196608 }, (_, index) => index % 251);
  const expected = input.slice();
  session.input(input);
  input.fill(255);
  const received: number[] = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(f.bridge.availableInput(), 65536);
    for (const byte of f.bridge.receive(65536)) received.push(byte);
    await turn();
  }
  assert.deepEqual(Uint8Array.from(received), expected);
  assert.equal(session.metrics.inputBytes, expected.length);
});

test("the 256 KiB page queue rejects an entire oversized call and accepts the exact limit", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  session.input(new Uint8Array(65536).fill(1));
  session.input(new Uint8Array(262144).fill(2));
  assert.throws(() => session.input(Uint8Array.of(4)), /256 KiB/);
  assert.equal(session.metrics.inputBytes, 327680);
  assert.deepEqual(f.bridge.receive(65536), new Uint8Array(65536).fill(1));
  await turn();
  assert.deepEqual(f.bridge.receive(65536), new Uint8Array(65536).fill(2));
});

test("output translates bare LF across drains without changing CRLF or binary bytes", async (context) => {
  const f = fixture(context);
  await f.starting;
  f.bridge.tryWrite([Uint8Array.of(65, 10, 13)]);
  await turn();
  f.bridge.tryWrite([Uint8Array.of(10, 0, 255, 10)]);
  await turn();
  assert.deepEqual(f.output, [65, 13, 10, 13, 10, 0, 255, 13, 10]);
});

test("resize forwards the new grid and an idle prompt updates its receipt", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  session.resize(120, 40);
  assert.equal(Atomics.load(f.bridge.state, api.control.cols), 120);
  assert.equal(Atomics.load(f.bridge.state, api.control.rows), 40);
  f.bridge.publishPrompt(130);
  await turn();
  assert.deepEqual(session.lastPrompt, { generation: 2n, status: 130 });
});

function submissionFrame(command: string): string {
  return `\x05\x15\x0b\x1b[200~${command}\x1b[201~\r`;
}

async function drainSubmission(bridge: SharedBridge, length: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let turnIndex = 0; turnIndex < 20 && received < length; turnIndex++) {
    await turn();
    const bytes = bridge.receive(65536);
    chunks.push(bytes);
    received += bytes.length;
  }
  assert.equal(received, length, "the complete frame drains within twenty pump turns");
  return Uint8Array.from(Buffer.concat(chunks));
}

for (const command of [
  "printf 'first\nsecond'\nfalse",
  "a\r\nb\rc",
  "",
  "literal\ttab",
  "literal\x00\x03\x05\x15\x0b\x7fcontrols",
  "false delimiter \x1b[201x and \x1b[200~",
  "x".repeat(65536),
  "é".repeat(32768),
].concat(
  ["\x1b", "\x1b[", "\x1b[2", "\x1b[20", "\x1b[201"].flatMap((suffix) => [
    "x".repeat(65536 - suffix.length) + suffix,
    "x".repeat(65536 - 9 - 1) + suffix,
  ]),
)) {
  const length = new TextEncoder().encode(command).length;
  test(
    `submission frames ${length} UTF-8 bytes ending ${JSON.stringify(command.slice(-16))}`,
    { timeout: 3000 },
    async (context) => {
      const f = fixture(context);
      const session = await f.starting;
      const submitting = session.submit(command);
      void submitting.catch(() => {});
      const frame = new TextEncoder().encode(submissionFrame(command));
      assert.deepEqual(await drainSubmission(f.bridge, frame.length), frame);
      assert.equal(session.metrics.inputBytes, frame.length);
      assert.equal(f.bridge.availableInput(), 0);
      f.bridge.publishPrompt(1);
      assert.equal(await submitting, undefined);
      assert.equal(session.lastExit, 1);
    },
  );
}

for (const command of [
  "x".repeat(65537),
  "é".repeat(32768) + "x",
  "é".repeat(32769),
  "\r\n".repeat(32769),
  "prefix\x1b[201~suffix",
]) {
  for (const pending of [false, true]) {
    test(
      `submission rejects ${new TextEncoder().encode(command).length} bytes before mutation, pending draft ${pending}`,
      { timeout: 3000 },
      async (context) => {
        const f = fixture(context);
        const session = await f.starting;
        const draft = pending ? "d".repeat(65536 + 17) : "";
        session.input(draft);
        const inputBytes = session.metrics.inputBytes;
        const write = Atomics.load(f.bridge.state, api.control.inputWrite);
        const read = Atomics.load(f.bridge.state, api.control.inputRead);
        const submitted = session.submit(command).then(
          () => undefined,
          (error: unknown) => error,
        );
        await turn();
        const written = Atomics.load(f.bridge.state, api.control.inputWrite);
        const acceptedBytes = session.metrics.inputBytes;
        f.bridge.publishPrompt(0);
        const error = await submitted;
        assert.ok(
          error instanceof RangeError,
          "unrepresentable drafts must reject, not await a guest receipt",
        );
        assert.match(error.message, command.includes("\x1b[201~") ? /paste terminator/ : /64 KiB/);
        assert.equal(written, write);
        assert.equal(Atomics.load(f.bridge.state, api.control.inputRead), read);
        assert.equal(acceptedBytes, inputBytes);
        assert.deepEqual(
          await drainSubmission(f.bridge, draft.length),
          new TextEncoder().encode(draft),
        );
        await turn();
        assert.equal(f.bridge.availableInput(), 0, "rejection did not leave queued bytes");
        const next = session.submit("true");
        const frame = new TextEncoder().encode(submissionFrame("true"));
        assert.deepEqual(await drainSubmission(f.bridge, frame.length), frame);
        f.bridge.publishPrompt(0);
        await next;
      },
    );
  }
}

test(
  "submission framing counts toward the unchanged page queue limit",
  { timeout: 3000 },
  async (context) => {
    const f = fixture(context);
    const session = await f.starting;
    const draft = new Uint8Array(262144).fill(100);
    session.input(draft);
    const inputBytes = session.metrics.inputBytes;
    await assert.rejects(session.submit("x".repeat(65536)), /256 KiB/);
    assert.equal(session.metrics.inputBytes, inputBytes);
    assert.deepEqual(await drainSubmission(f.bridge, draft.length), draft);
    await turn();
    assert.equal(f.bridge.availableInput(), 0);
  },
);

test("submission replaces the whole zsh draft with Ctrl+E, Ctrl+U, Ctrl+K and hands off output", async (context) => {
  const f = fixture(context, { lineEditor: { mode: "zsh" } });
  const session = await f.starting;
  const submitting = session.submit("printf new");
  void submitting.catch(() => {});
  assert.equal(session.running, true);
  await turn();
  assert.equal(new TextDecoder().decode(f.bridge.receive(65536)), submissionFrame("printf new"));
  phase(f.bridge, 2);
  await turn();
  assert.equal(session.state, "running");
  f.bridge.tryWrite([new TextEncoder().encode("new\n")]);
  f.bridge.publishPrompt(3);
  await submitting;
  assert.equal(session.state, "ready");
  assert.equal(session.lastExit, 3);
  assert.equal(new TextDecoder().decode(Uint8Array.from(f.output)), "new\r\n");
  assert.equal(session.running, false);
});

test("a prompt published after the phase snapshot wins before submit resolves", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  const submitting = session.submit("short command");
  await turn();
  f.bridge.receive(65536);
  Atomics.store(f.bridge.state, api.control.phase, 2);
  const read = f.bridge.readPrompt.bind(f.bridge);
  const receipt = context.mock.method(f.bridge, "readPrompt", () => {
    receipt.mock.restore();
    f.bridge.publishPrompt(5);
    return read();
  });
  // Run one real pump synchronously to place publication after its phase load,
  // before either the submission waiter or the next timer can repair the state.
  const pump: unknown = Reflect.get(session, "pump");
  assert.equal(typeof pump, "function");
  if (typeof pump !== "function") throw new Error("Missing session pump");
  Reflect.apply(pump, session, []);
  await submitting;
  assert.equal(session.lastExit, 5);
  assert.equal(session.state, "ready");
  assert.equal(session.running, false);
});

test("submissions serialize and recover after a rejected oversized submission", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  await assert.rejects(session.submit("x".repeat(262144)), /64 KiB/);
  const first = session.submit("one\nfalse");
  const second = session.submit("two");
  await turn();
  assert.equal(new TextDecoder().decode(f.bridge.receive(65536)), submissionFrame("one\nfalse"));
  await turn();
  assert.equal(f.bridge.availableInput(), 0, "the next submission waits for the final receipt");
  f.bridge.publishPrompt(1);
  await first;
  assert.equal(session.lastExit, 1);
  await turn();
  assert.equal(new TextDecoder().decode(f.bridge.receive(65536)), submissionFrame("two"));
  f.bridge.publishPrompt(0);
  await second;
});

test("submission refuses a foreground command rather than writing into its input", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  phase(f.bridge, 2);
  await assert.rejects(session.submit("do not send"), /foreground command/);
  assert.equal(f.bridge.availableInput(), 0);
});

test("Ctrl+C drops queued and inherited input before forwarding new keys", async (context) => {
  const f = fixture(context);
  const session = await f.starting;
  session.input(new Uint8Array(196608).fill(65));
  Atomics.store(f.bridge.state, api.control.inputLock, 1);
  session.input("\x03");
  assert.equal(f.interrupts(), 1);
  assert.equal(f.bridge.cancelled(), true);
  Atomics.store(f.bridge.state, api.control.inputLock, 0);
  f.bridge.signal();
  await turn();
  assert.equal(f.bridge.cancelled(), false);
  assert.equal(f.bridge.availableInput(), 0);
  session.input("fresh");
  assert.equal(new TextDecoder().decode(f.bridge.receive(65536)), "fresh");
});

test("host cancellation aborts pending submission, stops callbacks, and makes disposal idempotent", async (context) => {
  const controller = new AbortController();
  const f = fixture(context, { signal: controller.signal });
  const session = await f.starting;
  const submitting = session.submit("pending");
  const rejected = assert.rejects(submitting, /cancelled|closed/);
  await turn();
  controller.abort();
  const disposing = session.dispose();
  assert.equal(session.dispose(), disposing);
  await disposing;
  await rejected;
  const states = f.states.slice();
  session.input("ignored");
  session.interrupt();
  session.crash();
  f.bridge.publishPrompt(0);
  await turn();
  assert.deepEqual(f.states, states);
  assert.equal(f.disposals(), 1);
  assert.equal(f.owner.disposals, 0);
  assert.equal(session.running, false);
  await assert.rejects(session.submit("closed"), /closed/);
});
