import { expect } from "@playwright/test";
import { build, stop } from "esbuild";
import type {
  Budgets,
  HostCase,
  PreparationContext,
  SuiteAdapter,
  SuiteCase,
} from "waffle/testing/page-runner";
import { prepareSessionDrainFixture } from "../helpers/session-drain-fixture";
import {
  finiteNumber,
  record,
  sessionDrainFixturePath,
  sessionDrainIds,
  sessionDrainInventory,
  type SessionDrainRequest,
} from "./session-drain-support";

export const sessionDrainBudgets: Budgets = {
  hello: 20_000,
  heartbeat: 10_000,
  case: 60_000,
  teardown: 60_000,
  caseDocument: 150_000,
  group: 90_000,
  run: 2_160_000,
};
export const sessionDrainPreparationMs = 60_000;

export async function installSessionDrainFixture(host: HostCase): Promise<void> {
  await host.task(`await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Session drain fixture module failed to load"));
    script.src = ${JSON.stringify(sessionDrainFixturePath)};
    document.head.append(script);
  });`);
  host.signal.throwIfAborted();
  const remaining = host.remainingMs();
  if (remaining <= 0) throw new Error("Session drain setup/body deadline expired");
  await expect
    .poll(() => host.script("return window.sessionDrain?.acknowledgements === 1;"), {
      timeout: remaining,
    })
    .toBe(true);
}

async function idle(host: HostCase): Promise<unknown> {
  await host.sleep(100);
  const before = finiteNumber(await host.script("return window.sessionDrain.turns;"));
  await host.sleep(1000);
  const turns = finiteNumber(await host.script("return window.sessionDrain.turns;"));
  const evidence = { idleMs: 1000, drainTurns: turns - before };
  console.log(JSON.stringify(evidence));
  expect(turns - before).toBe(0);
  return evidence;
}

async function phases(host: HostCase): Promise<void> {
  await host.script('window.sessionDrain.action("phase", [2]);');
  await expect.poll(() => host.script("return window.sessionDrain.states.at(-1);")).toBe("running");
  await host.script('window.sessionDrain.action("write", [1, 2, 3]);');
  await expect.poll(() => host.script("return window.sessionDrain.output;")).toEqual([1, 2, 3]);
  await host.script('window.sessionDrain.action("phase", [1]);');
  await expect.poll(() => host.script("return window.sessionDrain.states.at(-1);")).toBe("ready");
}

async function paste(host: HostCase, reader: "receive" | "consume"): Promise<void> {
  await host.script(
    "window.sessionDrain.input(Array.from({ length: 196608 }, (_, i) => i % 251));",
  );
  for (let part = 1; part <= 3; part++) {
    await host.script(`window.sessionDrain.action(${JSON.stringify(reader)});`);
    await expect
      .poll(() => host.script("return window.sessionDrain.consumed.length;"))
      .toBe(part * 65536);
  }
  expect(await host.script("return window.sessionDrain.consumed;")).toEqual(
    Array.from({ length: 196608 }, (_, i) => i % 251),
  );
}

async function burst(host: HostCase): Promise<void> {
  const before = finiteNumber(await host.script("return window.sessionDrain.turns;"));
  await host.script('window.sessionDrain.action("burst");');
  await expect.poll(() => host.script("return window.sessionDrain.output.length;")).toBe(1000);
  expect(await host.script("return window.sessionDrain.output;")).toEqual(
    Array.from({ length: 1000 }, (_, i) => 32 + (i % 200)),
  );
  expect(await host.script("return window.sessionDrain.turns;")).toBeLessThan(before + 20);
  expect(await host.script("return window.sessionDrain.maximumDelivery;")).toBeLessThanOrEqual(
    32768,
  );
}

async function completedDrain(host: HostCase): Promise<void> {
  await host.task(`await new Promise((resolve) => {
    const waits = [];
    const delays = [];
    Reflect.set(window, "drainWaits", waits);
    Reflect.set(window, "drainDelays", delays);
    const wait = Atomics.waitAsync;
    const timeout = window.setTimeout;
    Reflect.set(window, "setTimeout", (handler, delay, ...args) => {
      delays.push(delay ?? 0);
      return timeout(handler, delay, ...args);
    });
    Reflect.set(Atomics, "waitAsync", (array, index, value) => {
      const result = wait(array, index, value);
      waits.push(result.async);
      Reflect.set(window, "setTimeout", timeout);
      resolve();
      return result;
    });
    window.sessionDrain.action("write", [42]);
  });`);
  await expect.poll(() => host.script("return window.sessionDrain.output;")).toEqual([42]);
  expect(await host.script('return Reflect.get(window, "drainWaits");')).toEqual([true]);
  expect(await host.script('return Reflect.get(window, "drainDelays");')).toEqual([8]);
}

async function capacity(host: HostCase): Promise<void> {
  await host.script(`window.sessionDrain.input(new Array(131072).fill(65));
    const bridge = Reflect.get(globalThis, "drainBridge");
    const drain = bridge.drain;
    bridge.drain = function (...args) {
      bridge.drain = drain;
      const bytes = drain.apply(bridge, args);
      bridge.receive(65536);
      Atomics.store(bridge.state, 11, 2);
      bridge.signal();
      return bytes;
    };
    window.sessionDrain.action("write", [42]);`);
  await expect.poll(() => host.script("return window.sessionDrain.states.at(-1);")).toBe("running");
  expect(await host.script('return Reflect.get(globalThis, "drainBridge").availableInput();')).toBe(
    65536,
  );
}

async function terminal(host: HostCase, kind: "exit" | "fail"): Promise<void> {
  await host.script(`window.sessionDrain.action(${JSON.stringify(kind)},
    Array.from({ length: 100000 }, (_, i) => 32 + (i % 200)));`);
  await expect.poll(() => host.script("return window.sessionDrain.output.length;")).toBe(100000);
  expect(await host.script("return window.sessionDrain.output;")).toEqual(
    Array.from({ length: 100000 }, (_, i) => 32 + (i % 200)),
  );
  expect(await host.script("return window.sessionDrain.states.at(-1);")).toMatch(/exited|failed/);
  expect(await host.script("return window.sessionDrain.terminalBytes;")).toBe(100000);
}

async function disposal(host: HostCase): Promise<void> {
  await host.task(`window.sessionDrain.action("burst");
    await window.sessionDrain.dispose();`);
  const before = await host.script(`return {
    turns: window.sessionDrain.turns,
    output: window.sessionDrain.output.length,
    states: window.sessionDrain.states.length,
  };`);
  await host.sleep(100);
  expect(
    await host.script(`return {
      turns: window.sessionDrain.turns,
      output: window.sessionDrain.output.length,
      states: window.sessionDrain.states.length,
    };`),
  ).toEqual(before);
}

async function race(host: HostCase): Promise<void> {
  await host.script("window.sessionDrain.race();");
  await expect.poll(() => host.script("return window.sessionDrain.output;")).toEqual([77]);
}

async function interrupt(host: HostCase): Promise<void> {
  await host.script('window.sessionDrain.action("lock");');
  await expect.poll(() => host.script("return window.sessionDrain.acknowledgements;")).toBe(2);
  await host.script(`window.sessionDrain.input(Array.from({ length: 196608 }, () => 65));
    window.sessionDrain.input([3]);`);
  await host.script('window.sessionDrain.action("unlock");');
  await expect.poll(() => host.script("return window.sessionDrain.states.at(-1);")).toBe("ready");
  await host.script("window.sessionDrain.input([42, 43]);");
  await host.script('window.sessionDrain.action("receive");');
  await expect.poll(() => host.script("return window.sessionDrain.consumed;")).toEqual([42, 43]);
}

const bodies = [
  idle,
  phases,
  (host: HostCase) => paste(host, "receive"),
  (host: HostCase) => paste(host, "consume"),
  burst,
  completedDrain,
  capacity,
  (host: HostCase) => terminal(host, "exit"),
  (host: HostCase) => terminal(host, "fail"),
  disposal,
  race,
  interrupt,
];

export function sessionDrainCases(): SuiteCase<SessionDrainRequest>[] {
  return sessionDrainInventory.map((item, index) => {
    const body = bodies[index];
    if (!body) throw new Error(`Missing callback for ${item.id}`);
    return {
      ...item,
      request: () => ({ id: item.id }),
      async drive(host) {
        await installSessionDrainFixture(host);
        const observation = await body(host);
        return { id: item.id, assertions: "pass", observation: observation ?? null };
      },
    };
  });
}

export function sessionDrainList(value: unknown): string[] {
  expect(value).toEqual({ ids: sessionDrainIds });
  return sessionDrainIds.slice();
}

export function checkSessionDrainResult(caseId: string, value: unknown): void {
  if (!record(value) || !record(value.body) || !record(value.teardown))
    throw new Error("Missing host body/teardown evidence");
  expect(value.body.status).toBe("pass");
  expect(value.teardown.status).toBe("pass");
  const body = value.body.result;
  const teardown = value.teardown.result;
  if (!record(body) || !record(teardown)) throw new Error("Missing session drain evidence");
  expect(body.id).toBe(caseId);
  expect(body.assertions).toBe("pass");
  expect(teardown.id).toBe(caseId);
  expect(teardown.afterEach).toBe("pass");
  expect(teardown.pageErrors).toEqual([]);
  expect(teardown.attachments).toEqual([]);
}

async function compileSessionDrainAssets(signal: AbortSignal) {
  signal.throwIfAborted();
  const { fixture } = await prepareSessionDrainFixture();
  signal.throwIfAborted();
  const page = await build({
    entryPoints: [new URL("./session-drain-page.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  signal.throwIfAborted();
  return {
    [sessionDrainFixturePath]: fixture,
    "/session-drain-page.js": page.outputFiles[0].text,
  };
}

export async function sessionDrainAssets(context: PreparationContext) {
  const until = performance.now() + sessionDrainPreparationMs;
  const preparation = new AbortController();
  const timer = setTimeout(
    () => preparation.abort(new Error("Session drain beforeAll timed out")),
    sessionDrainPreparationMs,
  );
  const signal = AbortSignal.any([context.signal, preparation.signal]);
  let stopping: Promise<void> | undefined;
  const stopCompiler = () => {
    stopping = stop();
    void stopping.catch(() => {});
  };
  signal.addEventListener("abort", stopCompiler, { once: true });
  try {
    // Keep the actual compiler consumer joined after an enclosing host wait expires.
    const assets = await compileSessionDrainAssets(signal);
    if (performance.now() >= until) throw new Error("Session drain beforeAll timed out");
    return assets;
  } finally {
    signal.removeEventListener("abort", stopCompiler);
    clearTimeout(timer);
    await stopping;
  }
}

export const sessionDrainAdapter: SuiteAdapter<SessionDrainRequest> = {
  suite: "bash-session-drain",
  inventory: sessionDrainCases,
  page: { path: "/drain-fixture", script: "/session-drain-page.js" },
  assets: sessionDrainAssets,
  budgets: () => ({ ...sessionDrainBudgets }),
  policy: { listIds: sessionDrainList, requireResult: true, check: checkSessionDrainResult },
};
