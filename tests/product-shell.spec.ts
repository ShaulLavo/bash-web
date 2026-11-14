import { test, expect } from "@playwright/test";

test("public editor saves exact text, terminal runs it, and the page retains its runtime", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/product-shell/product-shell.html");
  await expect(page.locator("#status")).toHaveText("ready");
  const snapshot = () => page.evaluate(() => window.productShell.snapshot());
  const editor = page.locator("#editor textarea");
  const terminal = page.locator("#terminal textarea");
  const original = "printf 'joined:%s\\n' draftx";

  await page.locator("#editor").click({ position: { x: 40, y: 15 } });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText(original);
  await expect.poll(async () => (await snapshot()).text).toBe(original);
  for (let index = 0; index < 6; index++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.insertText("editedx");
  await expect.poll(async () => (await snapshot()).text).toBe("printf 'joined:%s\\n' editedx");
  await page.keyboard.press("Backspace");
  const script = "printf 'joined:%s\\n' edited";
  await expect.poll(async () => (await snapshot()).text).toBe(script);
  expect((await snapshot()).inputBytes).toBe(0);

  await page.getByRole("button", { name: "Save script", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("saved");
  expect((await snapshot()).saved).toBe(script);
  expect((await snapshot()).savedReadback).toBe(script);
  await page.locator("#terminal").click();
  await expect(terminal).toBeFocused();
  await page.keyboard.insertText("source /workspace/smoke.sh");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await snapshot()).lines).toContain("joined:edited");
  await expect.poll(async () => (await snapshot()).state).toBe("ready");
  await expect
    .poll(async () => (await snapshot()).lines.filter(Boolean).at(-1))
    .toBe("integration$");
  expect((await snapshot()).prompt?.status).toBe(0);
  expect((await snapshot()).text).toBe(script);
  const before = await snapshot();

  await page.locator("#editor").click({ position: { x: 40, y: 15 } });
  await expect(editor).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.insertText("#");
  await expect.poll(async () => (await snapshot()).text).toBe(`${script}#`);
  expect((await snapshot()).inputBytes).toBe(before.inputBytes);
  expect((await snapshot()).lines).toEqual(before.lines);

  await page.getByRole("button", { name: "Dispose views", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("views disposed");
  await expect(page.locator("#editor textarea, #terminal textarea")).toHaveCount(0);
  const disposed = await snapshot();
  expect(disposed.runtimeDisposed).toBe(false);
  expect(disposed.borrowedReadback).toBe("owner-alive");
  expect(disposed.probeExit).toBe(0);
  await page.getByRole("button", { name: "Dispose runtime", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("runtime disposed");
  expect((await snapshot()).runtimeDisposed).toBe(true);
  expect(errors).toEqual([]);
  await testInfo.attach("release-integration", {
    body: JSON.stringify(
      { browser: testInfo.project.name, before, disposed },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
    contentType: "application/json",
  });
});
