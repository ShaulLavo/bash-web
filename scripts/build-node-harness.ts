import { build } from "esbuild";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
await build({
  absWorkingDir: root,
  entryPoints: { api: "scripts/waffle-node-api.ts", root: "scripts/waffle-root-worker.ts", program: "src/runtime/program-worker.ts", fs: "waffle/browser/fs-worker" },
  bundle: true, format: "esm", platform: "node", conditions: ["browser"], target: "node26", outdir: ".build/node", outExtension: { ".js": ".mjs" },
});
