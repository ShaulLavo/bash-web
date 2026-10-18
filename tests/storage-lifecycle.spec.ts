import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { STORAGE_READY_TIMEOUT_MS } from "../src/browser/storage.ts";
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
    await startupReady(second);
    await restarted;
  } finally {
    await second.close();
  }
});

// Serialized into only the first real filesystem worker response. Keep the native
// open/schema work, but withhold its success event so storage startup cannot finish.
function holdIndexedDBOpen() {
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, version) => {
    const request = open(name, version);
    request.addEventListener(
      "success",
      (event) => {
        event.stopImmediatePropagation();
        console.info("bash-web:test:indexeddb-open-held");
      },
      { once: true },
    );
    return request;
  };
}

for (const whenBusy of ["takeover", "wait"]) {
  test(`IndexedDB ${whenBusy} storage opening timeout allows Restart to complete`, async ({
    page,
  }) => {
    let heldOpens = 0;
    page.on("console", (message) => {
      if (message.text() === "bash-web:test:indexeddb-open-held") heldOpens++;
    });
    await page.route(
      "**/fs-worker*.js",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: `(${holdIndexedDBOpen.toString()})();\n${await response.text()}`,
        });
      },
      { times: 1 },
    );
    await page.clock.install();
    const query = new URLSearchParams({
      test: "1",
      renderer: "canvas",
      storage: "indexeddb",
      workspace: `bash-web-storage-opening-${randomUUID()}`,
    });
    // The takeover case deliberately exercises the unmodified IndexedDB default.
    if (whenBusy === "wait") query.set("whenBusy", "wait");
    await page.goto(`/?${query}`);
    await expect.poll(() => heldOpens).toBe(1);
    expect(await page.evaluate(() => window.bashWeb?.snapshot().storage?.status)).toBe("opening");
    expect(await page.evaluate(() => window.bashWeb?.metrics())).toBeUndefined();
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Exercise the real production guard; neither application timeout is shortened.
    await page.clock.fastForward(STORAGE_READY_TIMEOUT_MS + 1);
    await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
    await expect(page.getByRole("alert")).toContainText(
      "Browser storage did not become ready within 60 seconds.",
    );

    // The one-shot fault is gone. Restart must join the old owner's disposal,
    // acquire a new runtime on this same page and admit a real shell.
    const restarted = page.evaluate(() => window.bashWeb?.restart());
    await startupReady(page);
    await restarted;
    expect(heldOpens).toBe(1);
    expect(await page.evaluate(() => window.bashWeb?.snapshot().error)).toBeUndefined();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.locator("textarea").focus();
    await page.keyboard.insertText("printf 'storage-restarted\\n'");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
      .toContain("storage-restarted");
  });
}

test("OPFS takeover is rejected without changing the default storage policy", async ({ page }) => {
  await page.goto("/?test=1&renderer=canvas&storage=opfs&whenBusy=takeover");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
  await expect(page.getByRole("alert")).toContainText(
    'OPFS storage only supports whenBusy: "wait"',
  );
});
