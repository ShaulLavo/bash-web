import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

const baselineWorkers = new WeakMap<Page, number>();

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  baselineWorkers.set(page, page.workers().length);
  await page.locator("textarea").focus();
}

async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

async function output(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
    .toContain(text);
}

for (const [name, script, expected, status] of [
  ["default stdin", "printf 'one two\\nthree\\n' | wc", "2 3 14", 0],
  ["lines", "printf 'one two\\nthree\\n' | wc -l", "2", 0],
  ["words", "printf 'one two\\nthree\\n' | wc -w", "3", 0],
  ["bytes", "printf 'one two\\nthree\\n' | wc -c", "14", 0],
  ["binary bytes", "printf '\\377\\000a b\\n' | wc -c", "6", 0],
  ["pipeline", "printf 'one two\\nthree\\n' | cat | wc -c", "14", 0],
] as const) {
  test(`wc runs in Chromium with ${name}`, async ({ page }) => {
    await open(page);
    await command(page, `${script}; printf 'WC_STATUS:%s\\n' "$?"`);
    await output(page, expected);
    await output(page, `WC_STATUS:${status}`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

test("wc reads files and reports totals in Chromium", async ({ page }) => {
  await open(page);
  await command(page, "printf 'a b\\n' > one; printf 'x\\ny z\\n' > two; wc one two");
  await output(page, "1 2 4 one");
  await output(page, "2 3 6 two");
  await output(page, "3 5 10 total");
  await ready(page);
});

test("wc returns file and option errors without stopping the browser shell", async ({ page }) => {
  await open(page);
  await command(page, "wc missing; printf 'MISSING:%s\\n' \"$?\"");
  await output(page, "MISSING:1");
  await ready(page);
  await command(page, "wc --not-an-option; printf 'INVALID:%s\\n' \"$?\"");
  await output(page, "INVALID:2");
  await ready(page);
  await command(page, "printf 'one two\\n' | wc -w");
  await output(page, "2");
  await ready(page);
});

test("wc bounds memory on sustained input and stops on Ctrl+C", async ({ page }, info) => {
  await open(page);
  const baseline = baselineWorkers.get(page)!;
  const before = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!);
  await command(page, "export KEEP=retained; while printf x; do :; done | wc; echo BAD_AFTER");
  await expect.poll(() => page.workers().length).toBe(baseline + 1);
  await page.waitForTimeout(100);
  const memory: number[] = [];
  for (let sample = 0; sample < 8; sample++) {
    const guests = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].guests);
    expect(guests).toHaveLength(1);
    expect(guests[0].memoryBytes).toBeGreaterThan(0);
    memory.push(guests[0].memoryBytes);
    await page.waitForTimeout(25);
  }
  expect(Math.max(...memory)).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(Math.max(...memory) - Math.min(...memory)).toBeLessThanOrEqual(8 * 1024 * 1024);
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, 'printf \'INTERRUPT:%s:%s\\n\' "$?" "$KEEP"');
  await output(page, "INTERRUPT:130:retained");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
  expect(
    await page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AFTER");
  await info.attach("wc-sustained-input-memory", {
    body: JSON.stringify({
      memory,
      before: before.roots[0].memoryBytes,
      after: await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].memoryBytes),
    }),
    contentType: "application/json",
  });
});
