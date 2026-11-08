import { resolve } from "node:path";
import { runPageSuite } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { finalizeHostDiagnostics } from "../tests/ios/host-diagnostic-delivery";
import { createStartupAdapter } from "../tests/ios/startup-diagnostics";

const resultPath = resolve(process.argv[2] ?? ".scratch/startup-diagnostics-local.json");
const result = await runPageSuite(
  await createStartupAdapter(resultPath),
  (scratch) => new PlaywrightDriver("chromium", scratch),
  { resultPath, scratchRoot: process.env.TMPDIR ?? "/work/tmp", port: "ephemeral" },
);
process.exitCode = await finalizeHostDiagnostics(resultPath, result.exit, {
  selectDescriptor: (value) =>
    value !== null && typeof value === "object" && "diagnostic" in value
      ? value.diagnostic
      : undefined,
});
