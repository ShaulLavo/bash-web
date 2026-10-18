import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { startupReady } from "./helpers/readiness.ts";

async function waiting(page: Page) {
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("waiting");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().storage?.status)).toBe("waiting");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().error)).toBeUndefined();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Waiting for another tab to release storage…")).toBeVisible();
}

for (const storage of ["opfs", "indexeddb"]) {
  test(`${storage} waits without a shell timeout, then opens when its owning tab closes`, async ({
    context,
    page,
  }) => {
    const query = new URLSearchParams({
      test: "1",
      renderer: "canvas",
      storage,
      workspace: `bash-web-storage-${randomUUID()}`,
    });
    // OPFS defaults to waiting; IndexedDB retains its default takeover behavior unless opted in.
    if (storage === "indexeddb") query.set("whenBusy", "wait");
    await page.goto(`/?${query}`);
    await startupReady(page);
    const second = await context.newPage();
    try {
      query.set("startupTimeout", "3000");
      await second.goto(`/?${query}`);
      await waiting(second);
      await second.waitForTimeout(3300);
      await waiting(second);
      await page.close();
      await startupReady(second);
      await second.locator("textarea").focus();
      await second.keyboard.insertText("printf 'storage-resumed\\n'");
      await second.keyboard.press("Enter");
      await expect
        .poll(() => second.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
        .toContain("storage-resumed");
    } finally {
      await second.close();
    }
  });
}

test("awaited disposal cancels queued storage before a replacement runtime is acquired", async ({
  context,
  page,
}) => {
  const query = new URLSearchParams({
    test: "1",
    renderer: "canvas",
    storage: "opfs",
    workspace: `bash-web-storage-dispose-${randomUUID()}`,
  });
  await page.goto(`/?${query}`);
  await startupReady(page);
  const second = await context.newPage();
  try {
    await second.goto(`/?${query}`);
    await waiting(second);
    // This must finish while the other tab still owns the lock, without leaving a queued request.
    await second.evaluate(() => window.bashWeb?.dispose());
    expect(await second.evaluate(() => window.bashWeb?.metrics())).toBeUndefined();
    const restarted = second.evaluate(() => window.bashWeb?.restart());
    await waiting(second);
    await page.close();
    await restarted;
    await startupReady(second);
  } finally {
    await second.close();
  }
});

test("OPFS takeover is rejected without changing the default storage policy", async ({ page }) => {
  await page.goto("/?test=1&renderer=canvas&storage=opfs&whenBusy=takeover");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
  await expect(page.getByRole("alert")).toContainText(
    'OPFS storage only supports whenBusy: "wait"',
  );
});
