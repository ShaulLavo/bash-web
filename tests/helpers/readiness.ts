import { expect, test, type Page } from "@playwright/test";
import {
  storageBudget,
  waitForStartup,
  waitForShellReady,
  waitForStorageReady,
  type Read,
  type ReadinessPoll,
} from "./readiness-policy.ts";

const poll: ReadinessPoll = async (sample, options) => {
  await expect.poll(sample, options).toBe(true);
};

function observe(page: Page): Read {
  return () =>
    page.evaluate(() => ({
      snapshot: window.bashWeb?.snapshot(),
      failure: document.querySelector('[role="alert"]')?.textContent?.trim(),
    }));
}

/** Command completion and interrupt recovery retain the original five-second assertion. */
export async function ready(page: Page) {
  await waitForShellReady(observe(page), poll);
}

function browserStorageBudget() {
  return storageBudget(test.info().timeout, (timeout) => test.setTimeout(timeout));
}

/** Also used before asserting an intentional shell-start failure. */
export async function storageReady(page: Page) {
  const settled = browserStorageBudget();
  try {
    await waitForStorageReady(observe(page), poll);
  } finally {
    settled();
  }
}

/** Initial navigation and restart can open storage before starting the shell. */
export async function startupReady(page: Page) {
  await waitForStartup(observe(page), poll, browserStorageBudget());
}
