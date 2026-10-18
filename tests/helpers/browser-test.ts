import { test as base } from "@playwright/test";

export { expect, type Page } from "@playwright/test";
export const test = base.extend<{ startupDiagnostics: void }>({
  startupDiagnostics: [
    async ({ page }, use, testInfo) => {
      try {
        await use();
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          const snapshot = await page
            .evaluate(() => window.bashWeb?.snapshot())
            .catch(() => undefined);
          const body = JSON.stringify(snapshot ?? { unavailable: true }, null, 2);
          console.error(
            "Pending browser startup awaits",
            snapshot
              ? snapshot.startup.pending.join(", ") || "none observed"
              : "snapshot unavailable",
          );
          console.error("Browser startup diagnostics", body);
          await testInfo.attach("browser-startup-diagnostics", {
            body,
            contentType: "application/json",
          });
        }
      }
    },
    { auto: true },
  ],
});
