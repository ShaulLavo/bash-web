import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

const port = process.env.BASH_WEB_TEST_PORT ?? "4247";
export default defineConfig({
  ...base,
  testMatch: "**/file-utilities.spec.ts",
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: "npm run serve",
    env: { PORT: port },
    url: `http://127.0.0.1:${port}/file-utilities-tests.html`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
