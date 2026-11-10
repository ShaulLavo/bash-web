import { build } from "esbuild";
import { resolve } from "node:path";
import type { HostedPage, PreparationContext } from "waffle/testing/page-runner";
import { preparedPythonAssets } from "./python-assets";

export const pythonHostedPage: HostedPage = {
  path: "/python-tests.html",
  script: "/python-page.js",
};

export async function pythonHostAssets(context: PreparationContext) {
  const prepared = await preparedPythonAssets(context);
  context.signal.throwIfAborted();
  const page = await build({
    entryPoints: [resolve("tests/ios/python-page-main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  context.signal.throwIfAborted();
  // The owner serves this exact document path with its receiver, then loads the original module.
  delete prepared.assets[pythonHostedPage.path];
  return Object.assign(prepared.assets, { [pythonHostedPage.script]: page.outputFiles[0].text });
}
