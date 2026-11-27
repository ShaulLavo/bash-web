import { test, expect, type Page } from "./helpers/browser-test";
import { navigateTestPage } from "./helpers/navigate-test-page.ts";
import { ready, startupReady } from "./helpers/readiness.ts";

declare global {
  interface Window {
    controlInput: string[];
    clipboardCalls: { active: boolean; focused: boolean }[];
    finishClipboard?: (text: string) => void;
  }
}

const arrows = [
  { name: "Previous command", suffix: "A" },
  { name: "Next command", suffix: "B" },
  { name: "Move cursor left", suffix: "D" },
  { name: "Move cursor right", suffix: "C" },
];

async function open(page: Page) {
  await navigateTestPage(page, "/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
}

async function clipboard(page: Page, outcome: "text" | "empty" | "denied" | "pending" | "missing") {
  await page.evaluate((outcome) => {
    window.clipboardCalls = [];
    const readText = () => {
      window.clipboardCalls.push({
        active: navigator.userActivation.isActive,
        focused: document.activeElement === window.bashWeb!.terminal!.textarea,
      });
      if (outcome === "denied")
        return Promise.reject(new DOMException("Denied", "NotAllowedError"));
      if (outcome === "pending")
        return new Promise<string>((resolve) => {
          window.finishClipboard = resolve;
        });
      return Promise.resolve(outcome === "empty" ? "" : "echo TOUCH_A\r\necho TOUCH_B\r");
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: outcome === "missing" ? undefined : { readText },
    });
  }, outcome);
}

async function captureInput(page: Page) {
  await page.evaluate(() => {
    window.controlInput = [];
    window.bashWeb!.terminal!.onData((bytes) =>
      window.controlInput.push(new TextDecoder().decode(bytes)),
    );
  });
}

async function lines(page: Page) {
  return page.evaluate(() =>
    window
      .bashWeb!.readLines()
      .map((line) => line.trimEnd())
      .filter(Boolean),
  );
}

test.describe("touch terminal controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test.skip(({ browserName }) => browserName === "firefox", "Firefox has no touch emulation");

  test("touch actions paste, recall history, edit and keep typing", async ({ page }) => {
    await open(page);
    // Immediate assertion also records the missing consumer outcome on the unmodified page.
    expect(await page.getByRole("button", { name: "Paste", exact: true }).count()).toBe(1);
    await clipboard(page, "text");
    await page.getByRole("button", { name: "Paste", exact: true }).tap();
    await expect.poll(() => lines(page)).toEqual(["$ echo TOUCH_A", "echo TOUCH_B"]);
    expect(await page.evaluate(() => window.clipboardCalls)).toEqual([
      { active: true, focused: true },
    ]);
    await expect(page.locator("textarea")).toBeFocused();
    expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("ready");
    await page.keyboard.press("Enter");
    await ready(page);
    await expect.poll(() => lines(page)).toContain("TOUCH_B");
    await page.getByRole("button", { name: "Previous command" }).tap();
    await expect.poll(async () => (await lines(page)).at(-1)).toBe("echo TOUCH_B");
    await page.getByRole("button", { name: "Next command" }).tap();
    await expect.poll(async () => (await lines(page)).at(-1)).toBe("$");
    await page.keyboard.insertText("echo AC");
    await page.getByRole("button", { name: "Move cursor left" }).tap();
    await page.keyboard.insertText("B");
    await page.getByRole("button", { name: "Move cursor right" }).tap();
    await page.keyboard.insertText("D");
    await expect(page.locator("textarea")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => lines(page)).toContain("ABCD");
    const screenshot = test.info().outputPath("mobile-terminal-controls.png");
    await page.screenshot({ path: screenshot });
    await test
      .info()
      .attach("mobile-terminal-controls", { path: screenshot, contentType: "image/png" });
  });

  test("arrows use actual Ghostty normal and application cursor encodings", async ({ page }) => {
    await open(page);
    await captureInput(page);
    for (const mode of [false, true]) {
      await page.evaluate((enabled) => {
        window.bashWeb!.terminal!.write(`\x1b[?1${enabled ? "h" : "l"}`);
        window.controlInput = [];
      }, mode);
      for (const arrow of arrows) await page.getByRole("button", { name: arrow.name }).tap();
      expect(await page.evaluate(() => window.controlInput)).toEqual(
        arrows.map((arrow) => `\x1b${mode ? "O" : "["}${arrow.suffix}`),
      );
      await expect(page.locator("textarea")).toBeFocused();
    }
  });

  test("Paste uses Ghostty bracketed paste and newline encoding in both modes", async ({
    page,
  }) => {
    await open(page);
    await clipboard(page, "pending");
    await captureInput(page);
    for (const mode of [true, false]) {
      await page.evaluate((enabled) => {
        window.bashWeb!.terminal!.write(`\x1b[?2004${enabled ? "h" : "l"}`);
        window.controlInput = [];
      }, mode);
      await page.getByRole("button", { name: "Paste", exact: true }).tap();
      await page.evaluate(() => window.finishClipboard!("one\r\ntwo\nlast\r"));
      await expect
        .poll(() => page.evaluate(() => window.controlInput))
        .toEqual([mode ? "\x1b[200~one\r\ntwo\nlast\r\x1b[201~" : "one\r\rtwo\rlast\r"]);
    }
  });

  test("clipboard failures and empty text have bounded feedback without input or errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await open(page);
    await captureInput(page);
    await page.clock.install();
    for (const outcome of ["missing", "denied", "empty"] as const) {
      await clipboard(page, outcome);
      await page.getByRole("button", { name: "Paste", exact: true }).tap();
      await expect(page.getByRole("status", { name: "Clipboard notice" })).toHaveText(
        outcome === "missing"
          ? "Clipboard access is unavailable. Use your keyboard or system Paste menu."
          : outcome === "denied"
            ? "Could not read the clipboard. Allow access or use the system Paste menu."
            : "The clipboard is empty.",
      );
      await expect(page.locator("textarea")).toBeFocused();
      expect(await page.evaluate(() => window.controlInput)).toEqual([]);
    }
    await page.clock.fastForward(5000);
    await expect(page.getByRole("status", { name: "Clipboard notice" })).toBeEmpty();
    expect(errors).toEqual([]);
  });

  test("a clipboard read cannot paste into a restarted session", async ({ page }) => {
    await open(page);
    await clipboard(page, "pending");
    await page.getByRole("button", { name: "Paste", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Restart", exact: true }).tap();
    await startupReady(page);
    await captureInput(page);
    await page.evaluate(() => window.finishClipboard!("echo STALE\n"));
    await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.controlInput)).toEqual([]);
    expect(await lines(page)).toEqual(["$"]);
  });

  test("software keyboard space flows through the existing fit observer", async ({ page }) => {
    await open(page);
    const before = await page.evaluate(() => window.bashWeb!.snapshot());
    // Emulation does not open an OS keyboard. Model its visual viewport change and fractional scale drift.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "scale", { configurable: true, value: 1.0001 });
      Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 300 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() => page.evaluate(() => window.bashWeb!.snapshot().rows))
      .toBeLessThan(before.rows);
    await expect(page.locator(".below-terminal")).toBeHidden();
    const box = await page.getByRole("group", { name: "Terminal input controls" }).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(300);
    const fitted = await page.evaluate(() => window.bashWeb!.snapshot());
    expect(fitted.rows).toBeGreaterThan(0);
    expect(fitted.cols).toBe(before.cols);
    await page.getByRole("button", { name: "Move cursor left" }).tap();
    expect(await page.evaluate(() => window.bashWeb!.snapshot().rows)).toBe(fitted.rows);
    await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, "scale");
      Reflect.deleteProperty(window.visualViewport!, "height");
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => page.evaluate(() => window.bashWeb!.snapshot().rows)).toBe(before.rows);
  });

  test("a viewport shorter than the chrome keeps a fitted terminal and scrolls", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 220 });
    await open(page);
    await expect
      .poll(() => page.evaluate(() => window.bashWeb!.snapshot().rows))
      .toBeGreaterThanOrEqual(3);
    const fit = await page.evaluate(() => {
      const terminal = window.bashWeb!.terminal!;
      return {
        canvas: terminal.canvas!.clientHeight,
        element: terminal.element!.clientHeight,
        scrollable: document.documentElement.scrollHeight > innerHeight,
      };
    });
    expect(fit.canvas).toBeGreaterThan(0);
    expect(fit.canvas).toBeLessThanOrEqual(fit.element);
    expect(fit.scrollable).toBe(true);
    await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeAttached();
  });

  test("controls fit narrow and landscape viewports and resize the existing terminal", async ({
    page,
  }) => {
    await open(page);
    const before = await page.evaluate(() => window.bashWeb!.snapshot());
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 844, height: 390 },
      { width: 980, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          page.locator(".workbench").evaluate((node) => node.getBoundingClientRect().height),
        )
        .toBe(viewport.height);
      for (const name of ["Paste"].concat(arrows.map((arrow) => arrow.name))) {
        const button = page.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      }
      await expect
        .poll(() => page.evaluate(() => window.bashWeb!.snapshot().cols))
        .not.toBe(before.cols);
      const dimensions = await page.evaluate(() => window.bashWeb!.snapshot());
      await page.getByRole("button", { name: "Move cursor left" }).tap();
      const focused = await page.evaluate(() => window.bashWeb!.snapshot());
      expect({ cols: focused.cols, rows: focused.rows }).toEqual({
        cols: dimensions.cols,
        rows: dimensions.rows,
      });
    }
  });
});

test("desktop compatibility mousedown preserves focus without cancelling pointerdown or clicks", async ({
  page,
}) => {
  await open(page);
  await captureInput(page);
  const result = await page
    .getByRole("button", { name: "Move cursor left" })
    .evaluate((button) => ({
      pointerAllowed: button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }),
      ),
      mouseAllowed: button.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      ),
    }));
  expect(result).toEqual({ pointerAllowed: true, mouseAllowed: false });
  await page.getByRole("button", { name: "Move cursor left" }).click();
  await expect(page.locator("textarea")).toBeFocused();
  expect(await page.evaluate(() => window.controlInput)).toEqual(["\x1b[D"]);
  await page.keyboard.insertText("echo DESKTOP");
  await page.keyboard.press("Enter");
  await expect.poll(() => lines(page)).toContain("DESKTOP");
  const paste = page.getByRole("button", { name: "Paste", exact: true });
  await clipboard(page, "text");
  await paste.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("textarea")).toBeFocused();
  expect(await page.evaluate(() => window.clipboardCalls)).toEqual([
    { active: true, focused: true },
  ]);
});
