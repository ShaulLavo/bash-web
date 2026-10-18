import { test, expect } from "@playwright/test";
import { startupReady } from "./helpers/readiness.ts";

test("production startup loads an emitted Waffle filesystem worker", async ({ page, request }) => {
  const filesystemResponses: { url: string; status: number; type: string }[] = [];
  page.on("response", (response) => {
    if (!/\/fs-worker(?:-[^/]+)?\.js$/.test(new URL(response.url()).pathname)) return;
    filesystemResponses.push({
      url: response.url(),
      status: response.status(),
      type: response.headers()["content-type"] ?? "",
    });
  });
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  expect(filesystemResponses).toHaveLength(1);
  expect(filesystemResponses[0].status).toBe(200);
  expect(filesystemResponses[0].type).toMatch(/javascript/);
  // The un-hashed library URLs survive Vite replacing dist as well.
  for (const worker of ["fs-worker", "shell-worker"]) {
    const response = await request.get(`/${worker}.js`);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/javascript/);
    expect((await response.body()).byteLength).toBeGreaterThan(0);
  }
});

test("a browser exposing WebGPU without an adapter opens a working Canvas terminal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter: async () => null },
    });
  });
  await page.goto("/?test=1");
  await startupReady(page);
  expect(await page.evaluate(() => window.bashWeb?.snapshot().renderer)).toBe("canvas2d");
  await page.locator("textarea").focus();
  await page.keyboard.insertText("printf 'canvas-fallback-works\\n'");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
    .toContain("canvas-fallback-works");
});
