import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
}

async function lines(page: Page) {
  return page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trimEnd()));
}

test("actual terminal paste holds multiple commands until one explicit submission", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.bashWeb!.terminal!.paste("echo PASTE_A\r\necho PASTE_B\r"));
  await expect.poll(() => lines(page)).toEqual(["$ echo PASTE_A", "echo PASTE_B", ""]);
  expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("ready");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect
    .poll(() => lines(page))
    .toEqual(["$ echo PASTE_A", "echo PASTE_B", "", "PASTE_A", "PASTE_B", "$"]);
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(() => lines(page))
    .toEqual([
      "$ echo PASTE_A",
      "echo PASTE_B",
      "",
      "PASTE_A",
      "PASTE_B",
      "$ echo PASTE_A",
      "echo PASTE_B",
      "",
    ]);
});

test("Shift+Enter edits a multiline prompt and submits below its tail", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo SHIFT_A");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("echo SHIFT_B");
  await expect.poll(() => lines(page)).toEqual(["$ echo SHIFT_A", "echo SHIFT_B"]);
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect
    .poll(() => lines(page))
    .toEqual(["$ echo SHIFT_A", "echo SHIFT_B", "SHIFT_A", "SHIFT_B", "$"]);
});

test("multiline wrapped editing and resize preserve rows and the caret", async ({ page }) => {
  await open(page);
  const columns = await page.evaluate(() => window.bashWeb!.snapshot().cols);
  const first = "a".repeat(columns - 2);
  const second = "b".repeat(columns + 5);
  await page.evaluate(
    ({ first, second }) => window.bashWeb!.terminal!.paste(`${first}\n${second}\nTAIL`),
    { first, second },
  );
  await expect
    .poll(() => lines(page))
    .toEqual([`$ ${first}`, "b".repeat(columns), "bbbbb", "TAIL"]);
  await page.setViewportSize({ width: 620, height: 600 });
  await expect.poll(() => page.evaluate(() => window.bashWeb!.snapshot().cols)).not.toBe(columns);
  await page.keyboard.press("Home");
  await page.keyboard.press("Control+k");
  await expect.poll(() => lines(page)).toEqual(["$"]);
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.terminal!.geometry().cursor))
    .toEqual({ x: 2, y: 0, pendingWrap: false, visible: true });
  await page.keyboard.insertText("echo AFTER_RESIZE");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect.poll(() => lines(page)).toEqual(["$ echo AFTER_RESIZE", "AFTER_RESIZE", "$"]);
});
