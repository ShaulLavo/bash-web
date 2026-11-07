import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
async function tests(directory: string, suffix: string): Promise<string[]> {
  return (await readdir(resolve(root, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => resolve(root, directory, entry.name));
}
const entries = (await tests("src/runtime", ".test.ts")).concat(
  await tests("src/browser", ".test.ts"),
  await tests("tests", ".unit.ts"),
);
if (entries.length === 0) throw new Error("No runtime or terminal unit tests found");
// One page must load one Waffle package instance. Separate bundles duplicated its
// issued-declaration registry while sharing the page-wide reservation ledger.
const compiled = await build({
  stdin: {
    contents: entries.map((entry) => `import ${JSON.stringify(entry)};`).join("\n"),
    resolveDir: root,
    sourcefile: "runtime-terminal.test.ts",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["browser"],
  mainFields: ["browser", "module", "main"],
  external: ["node:*"],
  write: false,
  // Tests replace browser workers; imported adapter URL construction still needs
  // a file base rather than the data: URL of this in-memory test bundle.
  define: {
    "import.meta.url": JSON.stringify(pathToFileURL(resolve(root, "src/runtime/unit.ts")).href),
  },
  footer: { js: "//# sourceURL=bash-web-runtime-terminal.test.mjs" },
});
for (const file of compiled.outputFiles) {
  await import("data:text/javascript;base64," + Buffer.from(file.contents).toString("base64"));
}
