import { test, expect, type Page } from "./browser-test";
import { ready, startupReady } from "./readiness.ts";
import type { cutTrRecording } from "./cut-tr-recording.ts";

export async function command(page: Page, script: string) {
  await page.keyboard.insertText(script);
  await page.keyboard.press("Enter");
}

export async function output(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())))
    .toContain(text);
}

export async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
  await command(page, "export LC_ALL=C");
  await ready(page);
  return page.workers().length;
}

type BrowserCase = ReturnType<typeof cutTrRecording>["cases"][number];

async function compareCase(page: Page, entry: BrowserCase, index: number, workers: number) {
  const { name, script } = entry;
  await test.step(name, async () => {
    const bytes = Array.from(Buffer.from(entry.stdoutBase64, "base64")).join(",");
    const capture = `{ ${script}; } > /tmp/text-output 2> /tmp/text-error; text_status=$?; test-guest bytes < /tmp/text-output; printf 'TEXT_STATUS_${index}:%s\\n' "$text_status"; test -s /tmp/text-error; echo TEXT_ERROR_${index}:$?`;
    await command(page, capture);
    await output(page, `BYTES:${bytes}`);
    await output(page, `TEXT_STATUS_${index}:${entry.status}`);
    await output(page, `TEXT_ERROR_${index}:${entry.stderrPresent ? 0 : 1}`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(workers);
  });
}

export async function compareCases(page: Page, cases: readonly BrowserCase[], workers: number) {
  for (const [index, entry] of cases.entries()) await compareCase(page, entry, index, workers);
}
