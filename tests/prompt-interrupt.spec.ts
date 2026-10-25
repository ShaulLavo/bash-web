import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

async function command(page: Page, source: string) {
  await page.keyboard.insertText(source);
  await page.keyboard.press("Enter");
}

async function lines(page: Page) {
  return page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim()));
}

async function output(page: Page, expected: string) {
  await expect.poll(() => lines(page)).toContain(expected);
}

async function resources(page: Page) {
  const roots = await page.evaluate(() =>
    window.bashWeb!.runtimeSnapshot()!.roots.map((root) => ({
      pid: root.pid,
      liveProcesses: root.liveProcesses,
      liveJobs: root.liveJobs,
      retainedSlots: root.retainedSlots,
      pipes: root.pipes,
    })),
  );
  return { workers: page.workers().length, roots };
}

const cases = ["ETX", "runtime interrupt"].flatMap((path) =>
  ["empty", "typed"].flatMap((input) =>
    ["true", "false"].map((previous) => ({ path, input, previous })),
  ),
);

for (const { path, input, previous } of cases) {
  test(`prompt cancellation publishes 130 after ${previous}, ${input} input, ${path}`, async ({
    page,
  }, info) => {
    await page.goto("/?test=1&renderer=canvas&engine=own-shell");
    await startupReady(page);
    await page.locator("textarea").focus();
    const baseline = await resources(page);
    await command(
      page,
      "KEEP=retained; keepfn() { printf 'FUNCTION:%s\\n' \"$KEEP\"; }; mkdir prompt-dir; cd prompt-dir; test-guest ticker 0 50 PROMPT_BG >ticks & bg=$!; echo PROMPT_SETUP",
    );
    await output(page, "PROMPT_SETUP");
    await ready(page);
    await expect.poll(async () => (await resources(page)).workers).toBe(baseline.workers + 1);
    const background = await resources(page);
    await command(page, previous);
    await ready(page);
    if (input === "typed") {
      await page.keyboard.insertText("KEEP=discarded");
      await output(page, "$ KEEP=discarded");
    }
    const cancellations = (await lines(page)).filter((line) => line.endsWith("^C")).length;
    const inputBytes = await page.evaluate(() => window.bashWeb!.metrics()!.inputBytes);
    if (path === "ETX") {
      // NUL is ignored by the editor. This chunk bypasses the demo's single-ETX signal path.
      await page.evaluate(() => window.bashWeb!.terminal!.sendInput(new Uint8Array([0, 3])));
      await expect
        .poll(() => page.evaluate(() => window.bashWeb!.metrics()!.inputBytes))
        .toBe(inputBytes! + 2);
    } else {
      await page.keyboard.press("Control+c");
    }
    await expect
      .poll(async () => (await lines(page)).filter((line) => line.endsWith("^C")).length)
      .toBe(cancellations + 1);
    await ready(page);
    expect(await resources(page)).toEqual(background);
    await command(
      page,
      `printf 'PROMPT_STATUS:%s:%s\\n' "$?" "$KEEP"; printf 'ASYNC:%s:%s\\n' "$!" "$bg"; printf 'CWD:%s\\n' "$PWD"; keepfn; test-guest count ticks`,
    );
    await output(page, "PROMPT_STATUS:130:retained");
    await output(page, "CWD:/home/guest/prompt-dir");
    await output(page, "FUNCTION:retained");
    await ready(page);
    const retained = await lines(page);
    const asyncLine = retained.find((line) => /^ASYNC:\d+:\d+$/.test(line));
    expect(asyncLine).toBeDefined();
    const [, actual, expected] = asyncLine!.split(":");
    expect(actual).toBe(expected);
    expect(retained.some((line) => /^COUNT:[1-9]\d*:[1-9]\d*$/.test(line))).toBe(true);
    await command(page, "echo NEXT_STATUS:$?; kill %1; wait; echo BACKGROUND_REAPED");
    await output(page, "NEXT_STATUS:0");
    await output(page, "BACKGROUND_REAPED");
    await ready(page);
    await expect.poll(() => resources(page)).toEqual(baseline);
    await info.attach("prompt-interrupt-evidence", {
      body: JSON.stringify({ path, input, previous, baseline, background, retained }),
      contentType: "application/json",
    });
  });
}
