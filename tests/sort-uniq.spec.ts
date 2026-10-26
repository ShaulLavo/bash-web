import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, type Page } from "./helpers/browser-test";
import { startupReady, ready } from "./helpers/readiness.ts";
import { sortUniqCases } from "../scripts/sort-uniq-cases.ts";

function readLines(page: Page) {
  return page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()) ?? []);
}

test("sort and uniq run upstream GNU usage cases and load independently in the browser", async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on("request", (request) => {
    const match = /\/(sort|uniq)(?:-[^/]+)?\.wasm(?:\?|$)/.exec(request.url());
    if (match) fetched.push(match[1]);
  });
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  expect(fetched).toEqual([]);
  await page.locator("textarea").focus();
  const scratch = mkdtempSync(join(tmpdir(), "sort-uniq-browser-oracle-"));
  try {
    for (const [index, [name, script]] of sortUniqCases.entries()) {
      const expected = spawnSync("bash", ["-c", script], {
        cwd: scratch,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: "/tmp" },
        timeout: 3000,
      });
      if (expected.error) throw expected.error;
      const begin = `SORT_UNIQ_BEGIN_${index}`;
      const end = `SORT_UNIQ_END_${index}:${expected.status}`;
      await page.keyboard.insertText(
        `printf '${begin}\\n'; (${script}) 2>/tmp/program-error; rc=$?; printf 'SORT_UNIQ_END_${index}:%s\\n' "$rc"`,
      );
      await page.keyboard.press("Enter");
      await expect.poll(() => readLines(page), { message: name }).toContain(end);
      const lines = await page.evaluate(
        () => window.bashWeb?.readLines().map((line) => line.trim()) ?? [],
      );
      const start = lines.indexOf(begin);
      const finish = lines.indexOf(end);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const output = expected.stdout.toString().trimEnd();
      expect(lines.slice(start + 1, finish), name).toEqual(
        output ? output.split("\n").map((line) => line.trim()) : [],
      );
      await ready(page);
      if (index === 0) expect(fetched.filter((url) => url === "uniq")).toEqual([]);
    }
    for (const name of ["sort", "uniq"]) {
      await page.keyboard.insertText(`while :; do printf x; done | ${name}`);
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => window.bashWeb?.snapshot().state))
        .toBe("running");
      await page.keyboard.press("Control+c");
      await ready(page);
      await page.keyboard.insertText(`printf '${name}-interrupt:%s\\n' "$?"`);
      await page.keyboard.press("Enter");
      await expect.poll(() => readLines(page)).toContain(`${name}-interrupt:130`);
      await ready(page);
    }
    expect(fetched.filter((url) => url === "sort")).toHaveLength(1);
    expect(fetched.filter((url) => url === "uniq")).toHaveLength(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
