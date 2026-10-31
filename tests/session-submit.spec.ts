import { test, expect } from "./helpers/browser-test";
import { startupReady } from "./helpers/readiness.ts";

for (const mode of ["bash", "zsh"]) {
  test(`public session submit replaces a multiline ${mode} draft from its middle`, async ({
    page,
  }) => {
    await page.goto(`/?test=1&renderer=canvas&lineEditor=${mode}`);
    await startupReady(page);
    await page.locator("textarea").focus();
    await page.evaluate(() => window.bashWeb!.terminal!.paste("echo DRAFT_FIRST\necho DRAFT_LAST"));
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.bashWeb!.readLines().some((line) => line.includes("DRAFT_LAST")),
        ),
      )
      .toBe(true);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    await page.evaluate(() => window.bashWeb!.submit("printf 'REPLACED_ONLY\\n'"));
    await expect
      .poll(() =>
        page.evaluate(() =>
          window
            .bashWeb!.readLines()
            .map((line) => line.trimEnd())
            .filter(Boolean),
        ),
      )
      .toEqual(["$ printf 'REPLACED_ONLY\\n'", "REPLACED_ONLY", "$"]);
    expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("ready");
  });
}
