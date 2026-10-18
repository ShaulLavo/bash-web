// Bundle the Node compatibility instrument: the harness API, its stdio root, the
// production shell worker for every child program, and Waffle's filesystem worker.
import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await build({
  absWorkingDir: root,
  entryPoints: {
    api: "scripts/waffle-node-api.ts",
    root: "scripts/waffle-root-worker.ts",
    shell: "src/runtime/worker.ts",
    fs: "waffle/browser/fs-worker",
  },
  bundle: true,
  format: "esm",
  // The same Waffle source entries the browser build consumes; the harness supplies
  // Worker over node:worker_threads (node-worker-host.ts).
  platform: "neutral",
  conditions: ["browser"],
  external: ["node:*"],
  target: "node26",
  outdir: ".build/node",
  outExtension: { ".js": ".mjs" },
});
