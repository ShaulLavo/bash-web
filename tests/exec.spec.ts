import { test, expect } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const source of [false, true]) {
  for (const explicit of [false, true]) {
    test(`${source ? "source" : "prepared"} shell ${explicit ? "exec" : "final command"} replaces its Worker and keeps terminal completion pending`, async ({
      page,
    }) => {
      await page.goto(`/?test=1&renderer=canvas&rg=1${source ? "&exec=source" : ""}`);
      await startupReady(page);
      const baseline = page.workers();
      const shell = source ? "/bin/source-sh" : "/programs/shell-engine.wasm";
      const inner = `printf 'BEFORE_EXEC\\n'\nwhile [[ ! -f /exec-go ]]; do :; done\n${explicit ? "exec " : ""}test-guest ticker 0 100 AFTER_EXEC`;
      await page.evaluate(
        (command) => {
          void window.bashWeb!.submit(command);
        },
        `${shell} -c ${quote(inner)}`,
      );
      await expect
        .poll(() => page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())))
        .toContain("BEFORE_EXEC");
      const old = page.workers().find((worker) => !baseline.includes(worker));
      expect(old).toBeDefined();
      if (!old) throw new Error("The measured shell Worker was not observed");
      const oldClosed = old.waitForEvent("close");
      const before = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0]!);
      const child = before.records.find((record) => record.pid !== before.pid && !record.result);
      expect(child).toBeDefined();
      await page.evaluate(() => window.rgTest!.writeFile("/exec-go", "go"));
      await expect
        .poll(() => page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())))
        .toContain("AFTER_EXEC 0");
      await oldClosed;
      expect(await page.evaluate(() => window.bashWeb!.snapshot().state)).toBe("running");
      await expect.poll(() => page.workers().length).toBe(baseline.length + 1);
      const after = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0]!);
      expect(
        after.records
          .filter((record) => !record.result)
          .map((record) => record.pid)
          .sort(),
      ).toEqual([after.pid, child!.pid].sort());
      await page.locator("textarea").focus();
      await page.keyboard.press("Control+c");
      await ready(page);
      await page.evaluate(() => window.bashWeb!.submit("printf 'EXEC_STATUS:%s\\n' \"$?\""));
      await expect
        .poll(() => page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())))
        .toContain("EXEC_STATUS:130");
      await ready(page);
      await expect.poll(() => page.workers().length).toBe(baseline.length);
      await page.evaluate(() => window.bashWeb!.dispose());
      await expect.poll(() => page.workers().length).toBe(0);
    });
  }
}
