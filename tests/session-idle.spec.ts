import { test, expect } from "./helpers/browser-test";
import { startupReady } from "./helpers/readiness";

declare global {
  interface Window {
    idlePumpTimers: number;
  }
}

test("the real shell stays idle and resumes ordered output after silence", async ({ page }) => {
  await page.addInitScript(() => {
    window.idlePumpTimers = 0;
    const schedule = window.setTimeout;
    window.setTimeout = Object.assign(
      (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 8) window.idlePumpTimers++;
        return schedule(handler, timeout, ...args);
      },
      schedule,
    );
  });
  await page.goto("/?test=1&renderer=canvas&engine=own-shell");
  await startupReady(page);
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => window.idlePumpTimers);
  await page.waitForTimeout(1000);
  const timers = await page.evaluate(() => window.idlePumpTimers);
  console.log(JSON.stringify({ realShellIdleMs: 1000, eightMsTimers: timers - before }));
  expect(timers - before).toBe(0);
  await page.locator("textarea").focus();
  await page.keyboard.insertText("printf 'WAKE_FIRST\\nWAKE_SECOND\\n'");
  await page.keyboard.press("Enter");
  const lines = () => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  await expect.poll(lines).toContain("WAKE_FIRST");
  await expect.poll(lines).toContain("WAKE_SECOND");
  const ordered = await lines();
  expect(ordered).toBeDefined();
  if (!ordered) throw new Error("Shell lines unavailable");
  expect(ordered.indexOf("WAKE_FIRST")).toBeLessThan(ordered.indexOf("WAKE_SECOND"));
});
