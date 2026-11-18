import { test, expect, type Page } from "./helpers/browser-test";
import { navigateTestPage } from "./helpers/navigate-test-page.ts";
import { ready, startupReady } from "./helpers/readiness.ts";

test.beforeEach(async ({ page }) => {
  const viewport = { width: 420, height: 220 };
  await page.setViewportSize(viewport);
  await navigateTestPage(page, "/?test=1&renderer=canvas");
  await startupReady(page);
  // Shell readiness can precede the terminal's asynchronous initial fit.
  await expect.poll(() => page.evaluate(initialGeometryReady, viewport)).toBe(true);
  await page.locator("textarea").focus();
  await expect.poll(() => text(page)).toEqual(["$"]);
});

async function initialGeometryReady(viewport: Parameters<Page["setViewportSize"]>[0]) {
  await document.fonts.ready;
  const terminal = window.bashWeb?.terminal;
  const canvas = terminal?.canvas;
  const element = terminal?.element;
  const frame = terminal?.submittedFrame;
  if (!terminal || !canvas || !element || !frame || terminal.hasPendingFrame) return false;
  const geometry = terminal.geometry();
  const grid = terminal.appearance.grid;
  return (
    document.fonts.status === "loaded" &&
    innerWidth === viewport.width &&
    innerHeight === viewport.height &&
    canvas.clientWidth > 0 &&
    canvas.clientHeight > 0 &&
    canvas.clientWidth <= element.clientWidth &&
    canvas.clientHeight <= element.clientHeight &&
    canvas.width / frame.font.pixelRatio <= element.clientWidth &&
    canvas.height / frame.font.pixelRatio <= element.clientHeight &&
    frame.grid.columns === geometry.columns &&
    frame.grid.rows === geometry.rows &&
    grid.columns === geometry.columns &&
    grid.rows === geometry.rows
  );
}

/** Every row, history included, without trailing blank rows. */
async function text(page: Page) {
  const lines = await page.evaluate(() =>
    window.bashWeb!.readLines().map((line) => line.trimEnd()),
  );
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}
async function size(page: Page) {
  const { cols, rows } = await page.evaluate(() => window.bashWeb!.snapshot());
  return { columns: cols, rows };
}
async function screen(page: Page) {
  return page.evaluate(() => {
    const terminal = window.bashWeb!.terminal!;
    const lines = window.bashWeb!.readLines().map((line) => line.trimEnd());
    return lines.slice(terminal.lineCount() - terminal.appearance.grid.rows);
  });
}

test("Enter and Ctrl+C on a wrapped command's first row keep its rows intact", async ({ page }) => {
  const { columns } = await size(page);
  const tail = "x".repeat(columns);
  await page.keyboard.insertText(`echo ${tail}`);
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await ready(page);
  const first = `$ echo ${tail.slice(0, columns - 7)}`;
  await expect.poll(() => text(page)).toEqual([first, "x".repeat(7), tail, "$"]);
  // Ctrl+C drops unread input. Observe the draft and Home before cancelling.
  await page.keyboard.insertText("echo abc");
  await expect.poll(() => text(page)).toEqual([first, "x".repeat(7), tail, "$ echo abc"]);
  await page.keyboard.press("Home");
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.terminal!.geometry().cursor.x))
    .toBe(2);
  await page.keyboard.press("Control+c");
  await expect.poll(() => text(page)).toEqual([first, "x".repeat(7), tail, "$ echo abc^C", "$"]);
});

test("editing a command taller than the screen leaves one prompt in history", async ({ page }) => {
  const { columns, rows } = await size(page);
  const command = Array.from({ length: columns * (rows + 1) }, (_, at) =>
    String.fromCharCode(97 + (at % 26)),
  ).join("");
  await page.keyboard.insertText(command);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("Z");
  const edited = `$ ${command.slice(0, -1)}Z${command.slice(-1)}`;
  await expect.poll(async () => (await text(page)).join("")).toBe(edited);
  expect((await text(page)).filter((line) => line.startsWith("$ "))).toHaveLength(1);
  await page.keyboard.press("Home");
  await expect.poll(async () => (await screen(page))[0]).toBe(edited.slice(0, columns));
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.terminal!.geometry().cursor))
    .toMatchObject({ x: 2, y: 0 });
});

test("Ctrl+L clears the screen and keeps the command being edited", async ({ page }) => {
  await page.keyboard.insertText("echo OLD_OUTPUT");
  await page.keyboard.press("Enter");
  await ready(page);
  await page.keyboard.insertText("echo draft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+l");
  await expect.poll(async () => (await screen(page))[0]).toBe("$ echo draft");
  expect(await screen(page)).not.toContain("OLD_OUTPUT");
  await page.keyboard.insertText("X");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect
    .poll(async () => (await screen(page)).slice(0, 3))
    .toEqual(["$ echo drafXt", "drafXt", "$"]);
});

test("clear after an external command keeps new typing visible before Enter", async ({ page }) => {
  await page.keyboard.insertText("seq 1 30");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect.poll(() => text(page)).toContain("30");
  await page.keyboard.insertText("clear");
  await page.keyboard.press("Enter");
  await ready(page);
  await expect.poll(() => text(page)).toEqual(["$"]);
  await page.keyboard.insertText("echo CLEAR_4x");
  await expect.poll(() => text(page)).toEqual(["$ echo CLEAR_4x"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("2");
  await expect.poll(() => text(page)).toEqual(["$ echo CLEAR_42"]);
  await page.keyboard.press("Enter");
  await ready(page);
  await expect.poll(() => text(page)).toEqual(["$ echo CLEAR_42", "CLEAR_42", "$"]);
});
