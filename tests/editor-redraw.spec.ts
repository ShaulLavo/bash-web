import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 220 });
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
  await expect.poll(() => text(page)).toEqual(["$"]);
});

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
  await page.keyboard.insertText("echo abc");
  await page.keyboard.press("Home");
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
