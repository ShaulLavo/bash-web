import { defineConfig } from "@playwright/test";
import original from "../playwright.config.ts";
export default defineConfig({
  ...original,
  testDir: ".",
  testMatch: "pipeline-measure.spec.ts",
  projects: [{ name: "webkit", use: { browserName: "webkit" } }],
  retries: 0,
  maxFailures: 1,
  timeout: 60000,
  outputDir: "../measurement-output/test-results",
  reporter: [["list"], ["json", { outputFile: `${process.cwd()}/measurement-output/playwright.json` }]],
});
