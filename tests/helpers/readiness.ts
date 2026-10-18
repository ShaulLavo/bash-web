import { expect, test, type Page } from "@playwright/test";
import { STORAGE_READY_TIMEOUT_MS } from "../../src/browser/storage.ts";

export const SHELL_READY_TIMEOUT_MS = 5000;

type ReadinessSnapshot = {
  state?: string;
  storage?: { status: string };
  error?: string;
  // Preserve the whole startup diagnostic, including stage timestamps, when available.
  startup?: unknown;
};
export type ReadinessObservation = {
  snapshot?: ReadinessSnapshot;
  failure?: string;
};
type Read = () => Promise<ReadinessObservation>;
export type ReadinessPoll = (
  sample: () => Promise<boolean>,
  options: { timeout: number; message: string },
) => Promise<void>;

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

async function phase(read: Read, name: "storage" | "shell", wait: ReadinessPoll) {
  const timeout = name === "storage" ? STORAGE_READY_TIMEOUT_MS : SHELL_READY_TIMEOUT_MS;
  let last: ReadinessObservation | undefined;
  try {
    await wait(
      async () => {
        last = await read();
        return name === "storage"
          ? last.snapshot?.storage?.status === "ready"
          : last.snapshot?.state === "ready";
      },
      { timeout, message: `Browser readiness: ${name} phase (${timeout} ms)` },
    );
  } catch (cause) {
    throw new Error(
      `Browser readiness failed in ${name} phase (${timeout} ms). Last observation: ${JSON.stringify(last)}`,
      { cause },
    );
  }
}

/** Independent clocks: opening storage must not consume the shell's five seconds. */
export async function waitForStartup(
  read: Read,
  wait: ReadinessPoll = poll,
  storageSettled: () => void = () => {},
) {
  try {
    await phase(read, "storage", wait);
  } finally {
    storageSettled();
  }
  await waitForShellReady(read, wait);
}

export async function waitForShellReady(read: Read, wait: ReadinessPoll = poll) {
  await phase(read, "shell", wait);
}

/** Command completion and interrupt recovery retain the original five-second assertion. */
export async function ready(page: Page) {
  await waitForShellReady(observe(page));
}

export function storageBudget(
  originalTimeout = test.info().timeout,
  setTimeout: (timeout: number) => void = (timeout) => test.setTimeout(timeout),
  now: () => number = () => performance.now(),
) {
  const started = now();
  // The enclosing test must not expire before the app's separate storage-opening guard.
  if (originalTimeout !== 0) setTimeout(originalTimeout + STORAGE_READY_TIMEOUT_MS);
  return () => {
    // Credit only time spent waiting for storage, not another shell/assertion budget.
    if (originalTimeout !== 0) setTimeout(originalTimeout + Math.ceil(now() - started));
  };
}

/** Also used before asserting an intentional shell-start failure. */
export async function storageReady(page: Page) {
  const settled = storageBudget();
  try {
    await phase(observe(page), "storage", poll);
  } finally {
    settled();
  }
}

/** Initial navigation and restart can open storage before starting the shell. */
export async function startupReady(page: Page) {
  await waitForStartup(observe(page), poll, storageBudget());
}
