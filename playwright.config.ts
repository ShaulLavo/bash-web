import { defineConfig } from "@playwright/test";

const port = process.env.BASH_WEB_TEST_PORT ?? "4198";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL,
    viewport: { width: 1200, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-vulkan-surface"],
        },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: "npm run serve",
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
