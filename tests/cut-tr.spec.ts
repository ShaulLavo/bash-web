import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";
import { cutTrRecording } from "./helpers/cut-tr-recording.ts";

const { cases } = cutTrRecording();

async function command(page: Page, script: string) {
  await page.keyboard.insertText(script);
  await page.keyboard.press("Enter");
}

async function output(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())))
    .toContain(text);
}

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
  await command(page, "export LC_ALL=C");
  await ready(page);
  return page.workers().length;
}

type BrowserCase = (typeof cases)[number];

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

async function compareCases(page: Page, cases: readonly BrowserCase[], workers: number) {
  for (const [index, entry] of cases.entries()) await compareCase(page, entry, index, workers);
}

for (const name of ["cut", "tr"]) {
  test(`${name} stays separately lazy and matches GNU in the browser`, async ({ page }) => {
    test.setTimeout(180000);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    const workers = await open(page);
    const fetched = (program: string) =>
      requests.filter((path) => path.endsWith(`/${program}.wasm`));
    expect(fetched("cut")).toHaveLength(0);
    expect(fetched("tr")).toHaveLength(0);
    await compareCases(
      page,
      cases.filter(({ name: label }) => label.startsWith(`${name} `)),
      workers,
    );
    expect(fetched(name)).toHaveLength(1);
    expect(fetched(name === "cut" ? "tr" : "cut")).toHaveLength(0);
  });
}

test("cut and tr compose in browser pipelines", async ({ page }) => {
  const workers = await open(page);
  await compareCases(
    page,
    cases.filter(({ name }) => !name.startsWith("cut ") && !name.startsWith("tr ")),
    workers,
  );
});

for (const name of ["cut", "tr"]) {
  test(`${name} Ctrl+C returns status 130 and keeps the shell usable`, async ({ page }) => {
    const workers = await open(page);
    const commandLine = name === "cut" ? "cut -b1-" : "tr a-z A-Z";
    await command(
      page,
      `printf 'INTERRUPT_READY\\n'; while printf x; do :; done | ${commandLine} > /tmp/interrupted`,
    );
    await output(page, "INTERRUPT_READY");
    await expect.poll(() => page.workers().length).toBe(workers + 1);
    await page.keyboard.press("Control+c");
    await ready(page);
    await command(
      page,
      `echo TEXT_INTERRUPT:$?; ${name === "cut" ? "printf 'a:b\\n' | cut -d: -f2" : "printf b | tr a-z A-Z"}; echo TEXT_RECOVERED`,
    );
    await output(page, "TEXT_INTERRUPT:130");
    await output(page, name === "cut" ? "b" : "B");
    await output(page, "TEXT_RECOVERED");
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(workers);
  });
}
