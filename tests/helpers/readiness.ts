import { expect, test, type Page } from "@playwright/test";
import {
  waitForStartup,
  waitForShellReady,
  waitForStorageReady,
  type Read,
  type ReadinessPoll,
} from "./readiness-policy.ts";
import { OUTCOME_HANG_MS } from "./outcome-timeouts.ts";

const poll: ReadinessPoll = async (sample, options) => {
  await test.step(options.message, () => expect.poll(sample, options).toBe(true));
};

function observe(page: Page): Read {
  return () =>
    page.evaluate(() => ({
      snapshot: window.bashWeb?.snapshot(),
      failure: document.querySelector('[role="alert"]')?.textContent?.trim(),
    }));
}

export async function ready(page: Page) {
  await waitForShellReady(observe(page), poll, OUTCOME_HANG_MS);
}

/** Also used before asserting an intentional shell-start failure. */
export async function storageReady(page: Page) {
  await waitForStorageReady(observe(page), poll, OUTCOME_HANG_MS);
}

/** Initial navigation and restart can open storage before starting the shell. */
export async function startupReady(page: Page) {
  await waitForStartup(observe(page), poll, undefined, OUTCOME_HANG_MS);
}

export async function prepareOwnShell(page: Page) {
  await page.goto("/?test=1&renderer=canvas&engine=own-shell");
  await startupReady(page);
  expect(await page.evaluate(() => window.bashWeb?.snapshot().engine)).toBe("own-shell");
}
