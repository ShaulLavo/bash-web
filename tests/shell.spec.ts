import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady, storageReady } from "./helpers/readiness.ts";

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
}
async function lines(page: Page) {
  return page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()) ?? []);
}
async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
async function output(page: Page, text: string) {
  await expect.poll(() => lines(page)).toContain(text);
}

test("own shell executes real shell state, pipelines, files and command substitution", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    `export COLOR=violet; greet() { printf 'hello %s\\n' "$1"; }; mkdir demo; cd demo; printf 'file-data\\n' > note`,
  );
  await command(
    page,
    `printf '%s:%s\\n' "$COLOR" "$PWD"; greet browser; cat note | cat; printf 'sub:%s\\n' "$(printf nested)"`,
  );
  await output(page, "violet:/home/guest/demo");
  await output(page, "hello browser");
  await output(page, "file-data");
  await output(page, "sub:nested");
  await command(page, "false");
  await command(page, `printf 'exit:%s\\n' "$?"`);
  await output(page, "exit:1");
  await command(page, "missing_browser_command");
  await command(page, `printf 'missing:%s\\n' "$?"`);
  await output(page, "missing:127");
});

test("native cursor, Home/End, deletion and history", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo eding");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("it");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("g");
  await page.keyboard.press("Enter");
  await output(page, "editing");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await lines(page)).filter((line) => line === "editing").length)
    .toBe(2);
  await page.keyboard.press("Control+c");
});

test("Ctrl+C interrupts tight loops and stdin while retaining shell state", async ({ page }) => {
  await open(page);
  // Prove this invocation owns the running state before interrupting it.
  await command(page, "export KEEP=still-here; printf 'LOOP_READY\\n'; while :; do :; done");
  await output(page, "LOOP_READY");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, `printf 'interrupt:%s:%s\\n' "$?" "$KEEP"`);
  await output(page, "interrupt:130:still-here");
  await command(page, 'read answer; printf "stdin:%s\\n" "$answer"');
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await command(page, "typed-input");
  await output(page, "stdin:typed-input");
  await command(page, "cat");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, `printf 'recovered\\n'`);
  await output(page, "recovered");
});

test("resize editing restores a usable prompt", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText(`printf 'resized-edit\\n'`);
  await page.setViewportSize({ width: 620, height: 600 });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "resized-edit");
  const oldCols = await page.evaluate(() => window.bashWeb?.snapshot().cols);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().cols)).not.toBe(oldCols);
  await command(page, `printf 'demo-ended\\n'`);
  await output(page, "demo-ended");
});

test("bounded heavy streaming keeps the main thread responsive", async ({ page }) => {
  await open(page);
  await command(page, "seq 1000000");
  await page.waitForTimeout(250);
  const responsive = await page.evaluate(() => ({
    time: performance.now(),
    bytes: window.bashWeb?.metrics()?.outputBytes,
    inputBytes: window.bashWeb?.metrics()?.inputBytes,
    lines: window.bashWeb?.readLines().slice(-8),
    snapshot: window.bashWeb?.snapshot(),
    runtime: window.bashWeb?.runtimeSnapshot(),
  }));
  console.log(JSON.stringify({ streamingSample: responsive }));
  expect(responsive.bytes).toBeGreaterThan(1000);
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, `printf 'stream-ended\\n'`);
  await output(page, "stream-ended");
});

test("EOF closes session; worker failure is recoverable with Restart", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+d");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("exited");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await startupReady(page);
  await page.evaluate(() => window.bashWeb?.crash());
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
  await page.getByRole("button", { name: "Restart session" }).click();
  await startupReady(page);
  await command(page, `printf 'fresh-worker\\n'`);
  await output(page, "fresh-worker");
});

test("own shell applicable common command fixture", async ({ page }) => {
  await open(page);
  await command(
    page,
    `mkdir -p fixtures; printf 'common-fixture\\n' > fixtures/note; cat fixtures/note | cat; printf 'sub:%s\\n' "$(echo nested)"`,
  );
  await output(page, "common-fixture");
  await output(page, "sub:nested");
});

test("sleep and editing interruptions return to prompt", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("unfinished");
  await page.keyboard.press("Control+c");
  await command(page, "test-guest sleep 30000");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, "echo sleep-interrupted");
  await output(page, "sleep-interrupted");
});

test("$$ and BASHPID report a stable PID and the shell stays alive", async ({ page }) => {
  test.fixme(
    true,
    "Pending plan 004 $$/BASHPID runtime identity unit: the engine needs an authoritative PID hook.",
  );
  await open(page);
  await command(page, "echo pid:$$ bashpid:$BASHPID sub:$(echo $$); echo status:$?");
  const pid = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].pid);
  await output(page, `pid:${pid} bashpid:${pid} sub:${pid}`);
  await output(page, "status:0");
  await command(page, "echo after-pid");
  await output(page, "after-pid");
});

test("IME composition commits exactly once through Ghostty input", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo ");
  await page.locator("textarea").evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error("Terminal input missing");
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    node.value = "世界";
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "世界",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "世界" }));
    node.value = "世界";
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "世界",
        inputType: "insertCompositionText",
        isComposing: false,
      }),
    );
  });
  await page.keyboard.press("Enter");
  await output(page, "世界");
  expect(await lines(page)).not.toContain("世界世界");
});

test("missing WASM gives an actionable startup error and Restart recovers", async ({ page }) => {
  await page.route("**/programs/shell-engine.wasm", (route) => route.fulfill({ status: 404 }));
  await page.goto("/?test=1&renderer=canvas");
  await storageReady(page);
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("failed");
  await expect(page.getByRole("alert")).toContainText(/shell|WASM|fetch/i);
  await page.unroute("**/programs/shell-engine.wasm");
  await page.getByRole("button", { name: "Restart session" }).click();
  await startupReady(page);
  await command(page, "echo wasm-recovered");
  await output(page, "wasm-recovered");
});

test("long wrapped prompt survives resizing while editing and streaming", async ({ page }) => {
  await open(page);
  await command(page, `PS1='${"p".repeat(100)} $ '; echo long-prompt-ready`);
  await output(page, "long-prompt-ready");
  await page.keyboard.insertText("echo wrap-edited");
  await page.keyboard.press("ArrowLeft");
  await page.setViewportSize({ width: 580, height: 620 });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "wrap-edited");
  await command(page, "seq 1000000");
  try {
    await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  } catch (error) {
    console.log(
      JSON.stringify({
        wrappedStreamingState: await page.evaluate(() => ({
          snapshot: window.bashWeb?.snapshot(),
          runtime: window.bashWeb?.runtimeSnapshot(),
          metrics: window.bashWeb?.metrics(),
        })),
      }),
    );
    throw error;
  }
  await page.setViewportSize({ width: 950, height: 700 });
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, "echo resized-stream");
  await output(page, "resized-stream");
});
