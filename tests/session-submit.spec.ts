import { test, expect, type Page } from "./helpers/browser-test";
import { startupReady } from "./helpers/readiness.ts";

async function outputLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window
      .bashWeb!.readLines()
      .map((line) => line.trimEnd())
      .filter(Boolean),
  );
}

async function submissionError(page: Page, command: string): Promise<string> {
  return page.evaluate(async (command) => {
    try {
      await window.bashWeb!.submit(command);
      return "accepted";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, command);
}

async function openSession(page: Page, mode: string): Promise<void> {
  await page.goto(`/?test=1&renderer=canvas&lineEditor=${mode}`);
  await startupReady(page);
  await page.locator("textarea").focus();
}

for (const mode of ["bash", "zsh"]) {
  test(`public session submit replaces a multiline ${mode} draft from its middle`, async ({
    page,
  }) => {
    await openSession(page, mode);
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

  test(`public session submits one multiline ${mode} draft and preserves final status`, async ({
    page,
  }) => {
    await openSession(page, mode);
    await page.evaluate(async () => {
      await window.bashWeb!.submit("printf '%s\\n' 'SUBMIT_FIRST\nSUBMIT_LAST'\nfalse");
      await window.bashWeb!.submit("printf 'START_STATUS=%s\\n' \"$?\"");
    });
    await expect
      .poll(() => outputLines(page))
      .toEqual([
        "$ printf '%s\\n' 'SUBMIT_FIRST",
        "SUBMIT_LAST'",
        "false",
        "SUBMIT_FIRST",
        "SUBMIT_LAST",
        "$ printf 'START_STATUS=%s\\n' \"$?\"",
        "START_STATUS=1",
        "$",
      ]);
    expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("ready");
  });

  test(`public session preserves literal paste bytes and delimiter suffixes in ${mode} mode`, async ({
    page,
  }) => {
    await openSession(page, mode);
    await page.evaluate(() =>
      window.bashWeb!.submit(
        "value='a\t\x03\x05\x15\x0b\x7f\x1b[201x'; " +
          "[[ $value == $'a\\t\\003\\005\\025\\013\\177\\033[201x' ]] && printf 'LITERAL_OK\\n'\r\n" +
          "printf 'NEWLINE_OK\\n'\rfalse",
      ),
    );
    for (const suffix of ["\x1b", "\x1b[", "\x1b[2", "\x1b[20", "\x1b[201", "\x1b[201x"]) {
      await page.evaluate(
        (command) => window.bashWeb!.submit(command),
        "printf 'SUFFIX_OK\\n'; # " + suffix,
      );
    }
    await expect
      .poll(async () => {
        const lines = await outputLines(page);
        return lines.filter((line) => ["LITERAL_OK", "NEWLINE_OK", "SUFFIX_OK"].includes(line));
      })
      .toEqual(["LITERAL_OK", "NEWLINE_OK"].concat(Array.from({ length: 6 }, () => "SUFFIX_OK")));
    expect((await outputLines(page)).some((line) => line.includes("shell:"))).toBe(false);
    expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("ready");
  });

  test(`public session refuses unrepresentable ${mode} submissions without clearing its draft`, async ({
    page,
  }) => {
    await openSession(page, mode);
    await page.evaluate(() => window.bashWeb!.terminal!.paste("printf 'INTACT_DRAFT\\n'"));
    await expect.poll(() => outputLines(page)).toEqual(["$ printf 'INTACT_DRAFT\\n'"]);
    expect(await submissionError(page, "true;#" + "x".repeat(65531))).toContain("64 KiB");
    expect(await submissionError(page, "true;#\x1b[201~")).toContain("paste terminator");
    expect(await outputLines(page)).toEqual(["$ printf 'INTACT_DRAFT\\n'"]);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => outputLines(page))
      .toEqual(["$ printf 'INTACT_DRAFT\\n'", "INTACT_DRAFT", "$"]);
    await page.evaluate(() => window.bashWeb!.submit("printf 'RECOVERED\\n'"));
    await expect
      .poll(() => outputLines(page))
      .toEqual([
        "$ printf 'INTACT_DRAFT\\n'",
        "INTACT_DRAFT",
        "$ printf 'RECOVERED\\n'",
        "RECOVERED",
        "$",
      ]);
  });
}
