import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
  await expect.poll(() => lines(page)).toEqual(["$"]);
});

async function lines(page: Page) {
  return page.evaluate(() => {
    const terminal = window.bashWeb!.terminal!;
    const text = window.bashWeb!.readLines().map((line) => line.trimEnd());
    const cursor =
      terminal.lineCount() - terminal.appearance.grid.rows + terminal.geometry().cursor.y;
    const content = text.findLastIndex((line) => line.length > 0);
    return text.slice(0, Math.max(cursor, content) + 1);
  });
}

test("actual terminal paste holds multiple commands until one explicit submission", async ({
  page,
}) => {
  await page.evaluate(() => window.bashWeb!.terminal!.paste("echo PASTE_A\r\necho PASTE_B\r"));
  await expect.poll(() => lines(page)).toEqual(["$ echo PASTE_A", "echo PASTE_B", ""]);
  expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("ready");
  await test.info().attach("held-multiline-paste", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
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
  await page.keyboard.insertText("echo SHIFT_A");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("echo SHIFT_B");
  await expect.poll(() => lines(page)).toEqual(["$ echo SHIFT_A", "echo SHIFT_B"]);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect
    .poll(() => lines(page))
    .toEqual(["$ echo SHIFT_A", "echo SHIFT_B", "SHIFT_A", "SHIFT_B", "$"]);
});

test("multiline wrapped editing and resize preserve rows and the caret", async ({ page }) => {
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
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
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

test("a large Markdown paste moves between hard lines before history", async ({ page }) => {
  await page.keyboard.insertText("echo SAVED_HISTORY");
  await page.keyboard.press("Enter");
  await ready(page);
  const prefix = "# Document\n\nA short paragraph.\n\n".repeat(80);
  const markdown = `${prefix}## Last heading\n\nA final paragraph with unequal length.`;
  await page.evaluate((text) => window.bashWeb!.terminal!.paste(text), markdown);
  await expect
    .poll(async () => (await lines(page)).at(-1))
    .toBe("A final paragraph with unequal length.");
  await page.keyboard.press("Control+a");
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.terminal!.geometry().cursor.x))
    .toBe(0);
  await page.keyboard.insertText("!");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.insertText("?");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.insertText("#");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText(">");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.insertText("<");
  await expect
    .poll(async () => (await lines(page)).slice(-3))
    .toEqual(["### Last heading", ">?", "!A final paragraph with unequal length.<"]);
  expect(await page.evaluate(() => window.bashWeb!.terminal!.geometry().cursor.x)).toBe(40);
  await test.info().attach("large-markdown-hard-line-navigation", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.keyboard.press("Control+c");
  await ready(page);
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await lines(page)).at(-1)).toBe("$ echo SAVED_HISTORY");
});
