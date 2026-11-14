import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type BrowserContext } from "@playwright/test";

export const opfsTest = test.extend({
  context: async (
    { context, browserName, playwright, baseURL, viewport, contextOptions, headless },
    use,
  ) => {
    // Pinned WebKit rejects native OPFS in a nonpersistent context.
    if (browserName !== "webkit") {
      await use(context);
      return;
    }
    const profile = await mkdtemp(join(tmpdir(), "bash-web-opfs-"));
    let persistent: BrowserContext | undefined;
    try {
      persistent = await playwright.webkit.launchPersistentContext(profile, {
        ...contextOptions,
        baseURL,
        viewport,
        headless,
      });
      await use(persistent);
    } finally {
      await persistent?.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});
