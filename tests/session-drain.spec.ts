import { test, expect } from "./helpers/browser-test";
import { prepareSessionDrainFixture } from "./helpers/session-drain-fixture";

let fixture = "";

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

test.beforeAll(async () => {
  ({ fixture } = await prepareSessionDrainFixture());
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
    Array.from({ length: 1000 }, (_, i) => 32 + (i % 200)),
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
          Array.from({ length: 100000 }, (_, i) => 32 + (i % 200)),
        ),
      kind,
    );
    await expect.poll(() => page.evaluate(() => window.sessionDrain.output.length)).toBe(100000);
    expect(await page.evaluate(() => window.sessionDrain.output)).toEqual(
      Array.from({ length: 100000 }, (_, i) => 32 + (i % 200)),
    );
    expect(await page.evaluate(() => window.sessionDrain.states.at(-1))).toMatch(/exited|failed/);
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
