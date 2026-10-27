import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await build({
  absWorkingDir: root,
  entryPoints: {
    api: "scripts/waffle-node-api.ts",
    "env-command": "tests/helpers/env-command.ts",
    "file-utilities-api": "tests/helpers/file-utilities-api.ts",
    root: "scripts/waffle-root-worker.ts",
    child: "scripts/waffle-child-worker.ts",
    shell: "src/runtime/worker.ts",
    preview1: "waffle/browser/preview1-worker",
    fs: "waffle/browser/fs-worker",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["browser"],
  external: ["node:*"],
  target: "node26",
  outdir: ".build/node",
  outExtension: { ".js": ".mjs" },
});
