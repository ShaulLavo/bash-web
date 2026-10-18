import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
async function tests(directory, suffix) {
  return (await readdir(resolve(root, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => resolve(root, directory, entry.name));
}
const entries = (await tests("src/runtime", ".test.ts")).concat(
  await tests("src/browser", ".test.ts"),
  await tests("tests", ".unit.ts"),
);
if (entries.length === 0) throw new Error("No runtime or terminal unit tests found");
for (const entry of entries) {
  const compiled = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["browser"],
    external: ["node:*"],
    write: false,
    // Tests replace browser workers; imported adapter URL construction still needs
    // a file base rather than the data: URL of this in-memory test bundle.
    define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
    footer: { js: "//# sourceURL=bash-web-runtime-terminal.test.mjs" },
  });
  for (const file of compiled.outputFiles) {
    await import("data:text/javascript;base64," + Buffer.from(file.contents).toString("base64"));
  }
}
