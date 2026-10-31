import { test, expect } from "./helpers/browser-test";
import { build } from "esbuild";

let fixture = "";
let producer = "";

declare global {
  interface Window {
    sessionDrain: {
      output: number[];
      states: string[];
      turns: number;
      disposed: number;
      acknowledgements: number;
      consumed: number[];
      maximumDelivery: number;
      terminalBytes: number;
      race(): void;
      input(bytes: number[]): void;
      action(kind: string, bytes?: number[]): void;
      dispose(): Promise<void>;
    };
  }
}

const fixtureSource = `
import { BrowserSession } from "./src/browser/session";
import { SharedBridge } from "./src/bridge";
const output = [], states = [], consumed = [];
let turns = 0, disposed = 0, maximumDelivery = 0, acknowledgements = 0, terminalBytes = -1;
const drain = SharedBridge.prototype.drain;
SharedBridge.prototype.drain = function(...args) { turns++; return drain.apply(this,args); };
const session = await BrowserSession.create({
  runtime: {filesystem:{state:{status:"ready"}}}, cols:80, rows:24,
  onOutput(bytes) { maximumDelivery = Math.max(maximumDelivery,bytes.length); for(const byte of bytes) output.push(byte); },
  onState(state) { states.push(state); if(state === "exited" || state.startsWith("failed:")) terminalBytes = output.length; }
});
const workerURL = URL.createObjectURL(new Blob([PRODUCER], {type:"text/javascript"}));
const worker = new Worker(workerURL,{type:"module"});
worker.onmessage = ({data}) => { acknowledgements++; if(data.bytes) consumed.push(...data.bytes); };
worker.postMessage({kind:"init",buffer:globalThis.drainBridge.buffer});
window.sessionDrain = {
  output, states, consumed,
  get turns() { return turns; }, get disposed() { return disposed; },
  get terminalBytes() {return terminalBytes;},
  race() {
    const wait = Atomics.waitAsync;
    Atomics.waitAsync = (...args) => {
      Atomics.waitAsync = wait;
      globalThis.drainBridge.tryWrite([Uint8Array.of(77)]);
      return wait(...args);
    };
    globalThis.drainBridge.signal();
  },
  get maximumDelivery() { return maximumDelivery; }, get acknowledgements() { return acknowledgements; },
  input(bytes) {session.input(new Uint8Array(bytes));},
  action(kind,bytes) {worker.postMessage({kind,bytes});},
  async dispose() {await session.dispose(); disposed++; worker.terminate(); URL.revokeObjectURL(workerURL);}
};
`;

const stub = `
export { SharedBridge } from "./src/bridge";
export function runtimeSnapshot() { return {}; }
export async function createShell({terminal}) {
  globalThis.drainBridge = terminal;
  Atomics.store(terminal.state,11,1);
  return {process:{wasmBytes:0},done:new Promise(()=>{}),interrupt(){},async dispose(){}};
}
`;

const producerSource = `
import { SharedBridge, control } from "./src/bridge";
import { shellTerminalImports } from "./src/runtime/guest-imports";
let bridge;
onmessage = ({data}) => {
  if(data.kind === "init") {bridge = new SharedBridge(data.buffer); postMessage({}); return;}
  if(data.kind === "write") bridge.write(new Uint8Array(data.bytes));
  if(data.kind === "burst") for(let i=0;i<1000;i++) bridge.tryWrite([Uint8Array.of(i%256)]);
  if(data.kind === "phase") shellTerminalImports(bridge.buffer).phase(data.bytes[0], 0);
  if(data.kind === "consume") {const bytes = new Uint8Array(65536);const count = bridge.tryRead([bytes]);postMessage({bytes:Array.from(bytes.subarray(0,Math.max(0,count)))});return;}
  if(data.kind === "receive") {postMessage({bytes:Array.from(bridge.receive(65536))}); return;}
  if(data.kind === "lock") Atomics.store(bridge.state,control.inputLock,1);
  if(data.kind === "unlock") {Atomics.store(bridge.state,control.inputLock,0);bridge.signal();}
  if(data.kind === "exit" || data.kind === "fail") {
    bridge.write(new Uint8Array(data.bytes));
    Atomics.store(bridge.state,control.phase,data.kind === "exit" ? 3 : 4);
    bridge.signal();
  }
  postMessage({});
};
`;

test.beforeAll(async () => {
  const worker = await build({
    stdin: { contents: producerSource, resolveDir: process.cwd(), sourcefile: "drain-producer.js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  producer = worker.outputFiles[0].text;
  const output = await build({
    stdin: {
      contents: fixtureSource.replace("PRODUCER", JSON.stringify(producer)),
      resolveDir: process.cwd(),
      sourcefile: "drain-fixture.js",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "shell-admission-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/index$/ }, () => ({
            path: "shell-admission-fixture",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: stub,
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  fixture = output.outputFiles[0].text;
});

test.beforeEach(async ({ page, context }) => {
  page.on("pageerror", (error) => console.error(error.message));
  await context.route("**/drain-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
      body: "<!doctype html>",
    }),
  );
  await page.goto("/drain-fixture");
  await page.addScriptTag({ type: "module", content: fixture });
  await page.waitForFunction(() => window.sessionDrain?.acknowledgements === 1);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.sessionDrain?.dispose());
});

test("an idle session has no repeated drain turns", async ({ page }) => {
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => window.sessionDrain.turns);
  await page.waitForTimeout(1000);
  const turns = await page.evaluate(() => window.sessionDrain.turns);
  console.log(JSON.stringify({ idleMs: 1000, drainTurns: turns - before }));
  expect(turns - before).toBe(0);
});

test("worker output and phase-only changes wake a settled session", async ({ page }) => {
  await page.evaluate(() => window.sessionDrain.action("phase", [2]));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.states.at(-1))).toBe("running");
  await page.evaluate(() => window.sessionDrain.action("write", [1, 2, 3]));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.output)).toEqual([1, 2, 3]);
  await page.evaluate(() => window.sessionDrain.action("phase", [1]));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.states.at(-1))).toBe("ready");
});

for (const reader of ["receive", "consume"]) {
  test(`full-ring paste resumes through ${reader} without output`, async ({ page }) => {
    await page.evaluate(() =>
      window.sessionDrain.input(Array.from({ length: 196608 }, (_, i) => i % 251)),
    );
    for (let part = 1; part <= 3; part++) {
      await page.evaluate((reader) => window.sessionDrain.action(reader), reader);
      await expect
        .poll(() => page.evaluate(() => window.sessionDrain.consumed.length))
        .toBe(part * 65536);
    }
    expect(await page.evaluate(() => window.sessionDrain.consumed)).toEqual(
      Array.from({ length: 196608 }, (_, i) => i % 251),
    );
  });
}

test("burst output coalesces and each delivery stays bounded", async ({ page }) => {
  const before = await page.evaluate(() => window.sessionDrain.turns);
  await page.evaluate(() => window.sessionDrain.action("burst"));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.output.length)).toBe(1000);
  expect(await page.evaluate(() => window.sessionDrain.output)).toEqual(
    Array.from({ length: 1000 }, (_, i) => i % 256),
  );
  expect(await page.evaluate(() => window.sessionDrain.turns)).toBeLessThan(before + 20);
  expect(await page.evaluate(() => window.sessionDrain.maximumDelivery)).toBeLessThanOrEqual(32768);
});

test("a completed output drain waits for new activity without an empty follow-up turn", async ({
  page,
}) => {
  await page.evaluate(() => {
    const waits: boolean[] = [];
    const delays: number[] = [];
    Reflect.set(window, "drainWaits", waits);
    Reflect.set(window, "drainDelays", delays);
    const wait = Atomics.waitAsync;
    const timeout = window.setTimeout;
    Reflect.set(
      window,
      "setTimeout",
      (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        delays.push(delay ?? 0);
        return timeout(handler, delay, ...args);
      },
    );
    Reflect.set(Atomics, "waitAsync", (array: Int32Array, index: number, value: number) => {
      const result = wait(array, index, value);
      waits.push(result.async);
      Reflect.set(window, "setTimeout", timeout);
      return result;
    });
    window.sessionDrain.action("write", [42]);
  });
  await expect.poll(() => page.evaluate(() => window.sessionDrain.output)).toEqual([42]);
  expect(await page.evaluate(() => Reflect.get(window, "drainWaits"))).toEqual([true]);
  expect(await page.evaluate(() => Reflect.get(window, "drainDelays"))).toEqual([8]);
});

test("input capacity and phase published during a drain are handled before waiting", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sessionDrain.input(new Array<number>(131072).fill(65));
    const bridge = Reflect.get(globalThis, "drainBridge");
    const drain = bridge.drain;
    bridge.drain = function (...args: number[]) {
      bridge.drain = drain;
      const bytes = drain.apply(bridge, args);
      bridge.receive(65536);
      Atomics.store(bridge.state, 11, 2);
      bridge.signal();
      return bytes;
    };
    window.sessionDrain.action("write", [42]);
  });
  await expect.poll(() => page.evaluate(() => window.sessionDrain.states.at(-1))).toBe("running");
  expect(await page.evaluate(() => Reflect.get(globalThis, "drainBridge").availableInput())).toBe(
    65536,
  );
});

for (const kind of ["exit", "fail"]) {
  test(`${kind} retains final output larger than one drain`, async ({ page }) => {
    await page.evaluate(
      (kind) =>
        window.sessionDrain.action(
          kind,
          Array.from({ length: 100000 }, (_, i) => i % 251),
        ),
      kind,
    );
    await expect.poll(() => page.evaluate(() => window.sessionDrain.output.length)).toBe(100000);
    expect(await page.evaluate(() => window.sessionDrain.output)).toEqual(
      Array.from({ length: 100000 }, (_, i) => i % 251),
    );
    expect(await page.evaluate(() => window.sessionDrain.states.at(-1))).toMatch(/exited|failed:/);
    expect(await page.evaluate(() => window.sessionDrain.terminalBytes)).toBe(100000);
  });
}

test("dispose suppresses pending wake callbacks", async ({ page }) => {
  await page.evaluate(async () => {
    window.sessionDrain.action("burst");
    await window.sessionDrain.dispose();
  });
  const before = await page.evaluate(() => ({
    turns: window.sessionDrain.turns,
    output: window.sessionDrain.output.length,
    states: window.sessionDrain.states.length,
  }));
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => ({
      turns: window.sessionDrain.turns,
      output: window.sessionDrain.output.length,
      states: window.sessionDrain.states.length,
    })),
  ).toEqual(before);
});

test("publication between sampling and wait subscription is not missed", async ({ page }) => {
  await page.evaluate(() => window.sessionDrain.race());
  await expect.poll(() => page.evaluate(() => window.sessionDrain.output)).toEqual([77]);
});

test("interrupt clears a full paste after a contended reader unlocks", async ({ page }) => {
  await page.evaluate(() => window.sessionDrain.action("lock"));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.acknowledgements)).toBe(2);
  await page.evaluate(() => {
    window.sessionDrain.input(Array.from({ length: 196608 }, () => 65));
    window.sessionDrain.input([3]);
  });
  await page.evaluate(() => window.sessionDrain.action("unlock"));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.states.at(-1))).toBe("ready");
  await page.evaluate(() => window.sessionDrain.input([42, 43]));
  await page.evaluate(() => window.sessionDrain.action("receive"));
  await expect.poll(() => page.evaluate(() => window.sessionDrain.consumed)).toEqual([42, 43]);
});
