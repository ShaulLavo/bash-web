import { STORAGE_READY_TIMEOUT_MS } from "../../src/runtime/storage.ts";

// Native adapters retain their independent defaults; browser tests pass their shared hang cap.
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
export type Read = () => Promise<ReadinessObservation>;
export type ReadinessPoll = (
  sample: () => Promise<boolean>,
  options: { timeout: number; message: string },
) => Promise<void>;

async function phase(read: Read, name: "storage" | "shell", wait: ReadinessPoll, timeout: number) {
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

/** Storage opening and shell startup have independent observation clocks. */
export async function waitForStartup(
  read: Read,
  wait: ReadinessPoll,
  storageSettled: () => void = () => {},
  observationTimeoutMs?: number,
) {
  try {
    await waitForStorageReady(read, wait, observationTimeoutMs);
  } finally {
    storageSettled();
  }
  await waitForShellReady(read, wait, observationTimeoutMs);
}

export async function waitForShellReady(
  read: Read,
  wait: ReadinessPoll,
  observationTimeoutMs = SHELL_READY_TIMEOUT_MS,
) {
  await phase(read, "shell", wait, observationTimeoutMs);
}

export function storageBudget(
  originalTimeout: number,
  setTimeout: (timeout: number) => void,
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

export async function waitForStorageReady(
  read: Read,
  wait: ReadinessPoll,
  observationTimeoutMs = STORAGE_READY_TIMEOUT_MS,
) {
  await phase(read, "storage", wait, observationTimeoutMs);
}
