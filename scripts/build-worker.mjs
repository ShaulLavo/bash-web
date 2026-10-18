import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workers = ["shell-worker", "program-worker", "fs-worker"];
await build({
  absWorkingDir: root,
  entryPoints: {
    "shell-worker": resolve(root, "src/runtime/worker.ts"),
    "program-worker": resolve(root, "src/runtime/program-worker.ts"),
    // Consume Waffle's public worker entry; the application owns its served URL.
    "fs-worker": "waffle/browser/fs-worker",
  },
  outdir: resolve(root, ".build/browser"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
});
await mkdir(resolve(root, "dist"), { recursive: true });
for (const worker of workers) {
  await copyFile(resolve(root, `.build/browser/${worker}.js`), resolve(root, `dist/${worker}.js`));
}
