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

// Keep a real epoch transaction active after its lock grant. Abort still travels
// through native IndexedDB transaction events, so normal owner teardown can finish.
function holdIndexedDBEpoch() {
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) {
    const request = get.call(this, key);
    if (this.name !== "metadata" || key !== "epoch") return request;
    let reported = false;
    const hold = (event: Event) => {
      event.stopImmediatePropagation();
      if (!reported) console.info("bash-web:test:indexeddb-epoch-held");
      reported = true;
      const next = get.call(this, key);
      next.addEventListener("success", hold, { once: true });
    };
    request.addEventListener("success", hold, { once: true });
    return request;
  };
}

test("queued IndexedDB ownership is indefinite but stalled lock-acquired recovery times out", async ({
  context,
  page,
}) => {
  const query = new URLSearchParams({
    test: "1",
    renderer: "canvas",
    storage: "indexeddb",
    whenBusy: "wait",
    workspace: `bash-web-storage-recovery-${randomUUID()}`,
  });
  await page.goto(`/?${query}`);
  await startupReady(page);
  const second = await context.newPage();
  try {
    let heldEpochs = 0;
    second.on("console", (message) => {
      if (message.text() === "bash-web:test:indexeddb-epoch-held") heldEpochs++;
    });
    await second.route(
      "**/fs-worker*.js",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: `(${holdIndexedDBEpoch.toString()})();\n${await response.text()}`,
        });
      },
      { times: 1 },
    );
    await second.clock.install();
    await second.goto(`/?${query}`);
    await waiting(second);
    expect(
      await second.evaluate(
        () => window.bashWeb?.snapshot().startup.stages["filesystem-lock-acquired"],
      ),
    ).toBeUndefined();
    await second.clock.fastForward(STORAGE_READY_TIMEOUT_MS * 3);
    await waiting(second);
    expect(heldEpochs).toBe(0);
    await page.close();
    await expect.poll(() => heldEpochs).toBe(1);
    await expect
      .poll(() =>
        second.evaluate(
          () => window.bashWeb?.snapshot().startup.stages["filesystem-lock-acquired"],
        ),
      )
      .toBeDefined();
    const recovering = await second.evaluate(() => window.bashWeb!.snapshot());
    expect(recovering.storage?.status).toBe("waiting");
    expect(recovering.startup.stages["filesystem-lock-acquired"]).toBeDefined();
    expect(recovering.startup.stages["filesystem-epoch-resolved"]).toBeUndefined();
    expect(recovering.startup.stages["storage-wait-resolved"]).toBeUndefined();
    expect(recovering.startup.pending).toContain("storage-wait-requested");
    expect(await second.evaluate(() => window.bashWeb?.metrics())).toBeUndefined();
    await second.clock.fastForward(STORAGE_READY_TIMEOUT_MS + 1);
    await expect.poll(() => second.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
    await expect(second.getByRole("alert")).toContainText(
      "Browser storage recovery did not finish within 60 seconds.",
    );
    expect(
      await second.evaluate(
        () => window.bashWeb?.snapshot().startup.stages["filesystem-lock-acquired"],
      ),
    ).toBe(recovering.startup.stages["filesystem-lock-acquired"]);
    const restarted = second.evaluate(() => window.bashWeb?.restart());
    await startupReady(second);
    await restarted;
    expect(heldEpochs).toBe(1);
    await second.locator("textarea").focus();
    await second.keyboard.insertText("printf 'recovery-restarted\\n'");
    await second.keyboard.press("Enter");
    await expect
      .poll(() => second.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
      .toContain("recovery-restarted");
  } finally {
    await second.close();
  }
});

async function foreignWorkspace(page: Page, name: string) {
  await page.route("**/storage-seed", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Storage fixture</title>",
    }),
  );
  await page.goto("/storage-seed");
  await page.evaluate(async (workspace) => {
    const request = indexedDB.open(workspace, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("foreign");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("foreign", "readwrite");
    transaction.objectStore("foreign").put("owner-data", "sentinel");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, name);
}

async function preservedWorkspace(page: Page, name: string) {
  return page.evaluate(async (workspace) => {
    const request = indexedDB.open(workspace);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = Array.from(db.objectStoreNames);
    const read = db.transaction("foreign").objectStore("foreign").get("sentinel");
    const value = await new Promise<unknown>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    db.close();
    return { stores, value };
  }, name);
}

test("foreign IndexedDB shows INVALID_VFS_FORMAT and Restart never wipes owner data", async ({
  page,
}) => {
  const name = `bash-web-foreign-${randomUUID()}`;
  await foreignWorkspace(page, name);
  const query = new URLSearchParams({ test: "1", renderer: "canvas", workspace: name });
  await page.goto(`/?${query}`);
  await expect(page.getByRole("alert")).toContainText("INVALID_VFS_FORMAT");
  expect(await page.evaluate(() => window.bashWeb?.metrics())).toBeUndefined();
  expect(await preservedWorkspace(page, name)).toEqual({
    stores: ["foreign"],
    value: "owner-data",
  });
  await page.evaluate(() => window.bashWeb?.restart());
  await expect(page.getByRole("alert")).toContainText("INVALID_VFS_FORMAT");
  expect(await preservedWorkspace(page, name)).toEqual({
    stores: ["foreign"],
    value: "owner-data",
  });
});

test("SAFE fails with its typed unsupported error without falling back to FAST", async ({
  page,
}) => {
  const name = `bash-web-safe-${randomUUID()}`;
  const query = new URLSearchParams({
    test: "1",
    renderer: "canvas",
    storage: "safe",
    workspace: name,
  });
  await page.goto(`/?${query}`);
  await expect(page.getByRole("alert")).toContainText("UNSUPPORTED_VFS");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
  expect(await page.evaluate(() => window.bashWeb?.metrics())).toBeUndefined();
  expect(
    await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name)),
  ).not.toContain(name);
});
