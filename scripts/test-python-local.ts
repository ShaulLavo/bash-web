import { resolve } from "node:path";
import { runPageSuite } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { createPythonAdapter } from "../tests/ios/python-adapter";

const resultPath = resolve(process.argv[2] ?? ".scratch/python-local.json");
const engine = process.argv[3] ?? "chromium";
if (engine !== "chromium" && engine !== "firefox") throw new Error("Unknown Python control engine");
const result = await runPageSuite(
  await createPythonAdapter(resultPath),
  (scratch) => new PlaywrightDriver(engine, scratch),
  { resultPath, scratchRoot: process.env.TMPDIR ?? "/work/tmp", port: "ephemeral" },
);
process.exitCode = result.exit;
