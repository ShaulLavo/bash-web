import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

async function command(page: Page, script: string) {
  await page.keyboard.insertText(script);
  await page.keyboard.press("Enter");
  await ready(page);
}

function bytes(value: string): string {
  return `BYTES:${Array.from(new TextEncoder().encode(value)).join(",")}`;
}

test("upstream ls loads once on first use and preserves GNU fixture bytes in a browser", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/ls.wasm")) requests.push(request.url());
  });
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  expect(requests).toHaveLength(0);
  await page.locator("textarea").focus();
  await command(
    page,
    "mkdir -p /listing/sub /listing/empty; cd /listing; printf A > Alpha; printf bb > beta; printf ccc > 'space name'; printf secret > .hidden; printf nested > sub/child; printf '' > zeta",
  );
  const cases = [
    { args: "", expected: "Alpha\nbeta\nempty\nspace name\nsub\nzeta\n" },
    { args: "-a", expected: ".\n..\n.hidden\nAlpha\nbeta\nempty\nspace name\nsub\nzeta\n" },
    { args: "-1", expected: "Alpha\nbeta\nempty\nspace name\nsub\nzeta\n" },
    { args: "/listing/sub", expected: "child\n" },
    { args: "sub empty", expected: "empty:\n\nsub:\nchild\n" },
    {
      args: "-l --time-style=+FIXED Alpha",
      expected: "-r-xr-xr-x 1 somebody somegroup 1 FIXED Alpha\n",
    },
  ];
  for (const value of cases) {
    await command(page, `ls ${value.args} > /ls-result; cat /ls-result | test-guest bytes`);
    await expect
      .poll(() => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
      .toContain(bytes(value.expected));
  }
  expect(requests).toHaveLength(1);
  await command(page, "ls absent >/ls-result 2>/ls-error; printf 'LS_STATUS:%s\\n' \"$?\"");
  await expect
    .poll(() => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
    .toContain("LS_STATUS:2");
});
