import { test, expect } from "./helpers/browser-test";

test("startup diagnostics expose a stalled shell fetch before session assignment", async ({
  page,
}) => {
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/programs/shell-engine.wasm", async (route) => {
    entered();
    await held;
    await route.continue();
  });
  try {
    await page.goto("/?test=1&renderer=canvas");
    await requested;
    const snapshot = await page.evaluate(() => window.bashWeb!.snapshot());
    expect(snapshot.state).toBe("starting");
    expect(snapshot.startup.pending).toContain("shell-wasm-fetch-requested");
    expect(snapshot.startup.stages["shell-wasm-fetch-resolved"]).toBeUndefined();
    expect(await page.evaluate(() => window.bashWeb!.runtimeSnapshot())).toBeUndefined();
  } finally {
    release();
  }
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("ready");
  const snapshot = await page.evaluate(() => window.bashWeb!.snapshot());
  expect(snapshot.startup.pending).toEqual([]);
  expect(snapshot.startup.stages["shell-wasm-fetch-resolved"]).toBeGreaterThanOrEqual(
    snapshot.startup.stages["shell-wasm-fetch-requested"]!,
  );
});

test("the runtime lease forwards the real filesystem startup milestones", async ({ page }) => {
  await page.goto("/?test=1&renderer=canvas");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("ready");
  const snapshot = await page.evaluate(() => window.bashWeb!.snapshot().startup);
  const expected = [
    "filesystem-worker-created",
    "filesystem-connect-requested",
    "filesystem-connected",
    "indexeddb-open-requested",
    "indexeddb-open-resolved",
    "filesystem-lock-requested",
    "filesystem-lock-acquired",
    "filesystem-epoch-requested",
    "filesystem-epoch-resolved",
    "filesystem-ready",
  ] as const;
  let previous = snapshot.stages["runtime-lease-requested"]!;
  for (const stage of expected) {
    expect(snapshot.stages[stage], stage).toBeGreaterThanOrEqual(previous);
    previous = snapshot.stages[stage]!;
  }
  expect(snapshot.pending).toEqual([]);
});

test("restart resets startup timestamps without retaining a previous generation", async ({
  page,
}) => {
  await page.goto("/?test=1&renderer=canvas");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("ready");
  const previous = await page.evaluate(() => window.bashWeb!.snapshot().startup);
  await page.evaluate(() => window.bashWeb!.restart());
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("ready");
  const next = await page.evaluate(() => window.bashWeb!.snapshot().startup);
  expect(next.generation).toBeGreaterThan(previous.generation);
  expect(next.stages["runtime-lease-requested"]).toBeGreaterThan(
    previous.stages["runtime-lease-resolved"]!,
  );
  expect(next.pending).toEqual([]);
});
