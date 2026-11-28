import { build } from "esbuild";
import { resolve } from "node:path";
import { verifyInstalledWaffle } from "./build/installed-waffle.ts";

const root = resolve(import.meta.dirname, "..");
verifyInstalledWaffle(root);
await build({
  absWorkingDir: root,
  entryPoints: {
    api: "scripts/build/waffle-node-api.ts",
    root: "scripts/build/waffle-root-worker.ts",
    child: "scripts/build/waffle-child-worker.ts",
    shell: "src/runtime/worker.ts",
    preview1: "waffle/browser/preview1-worker",
    fs: "scripts/build/waffle-fs-worker.ts",
    thread: "scripts/build/node-worker-thread.ts",
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
