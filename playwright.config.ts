import { defineConfig } from "@playwright/test";
import { BROWSER_CASE_HANG_MS, OUTCOME_HANG_MS } from "./tests/helpers/outcome-timeouts.ts";

const port = process.env.BASH_WEB_TEST_PORT ?? "4198";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 2,
  timeout: BROWSER_CASE_HANG_MS,
  expect: { timeout: OUTCOME_HANG_MS, toPass: { timeout: OUTCOME_HANG_MS } },
  use: {
    baseURL,
    viewport: { width: 1200, height: 800 },
    actionTimeout: OUTCOME_HANG_MS,
    navigationTimeout: OUTCOME_HANG_MS,
    launchOptions: { timeout: OUTCOME_HANG_MS },
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          timeout: OUTCOME_HANG_MS,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-vulkan-surface"],
        },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm run serve",
    env: { PORT: port, BASH_WEB_TEST_FIXTURES: "1" },
    url: baseURL,
    reuseExistingServer: false,
    timeout: OUTCOME_HANG_MS,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
