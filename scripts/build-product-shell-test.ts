import { build } from "vite";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await build({
  configFile: false,
  root: resolve(root, "tests"),
  base: "/product-shell/",
  publicDir: false,
  build: {
    target: "esnext",
    outDir: resolve(root, "dist/product-shell"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, "tests/product-shell.html") },
  },
});
await copyFile(
  resolve(root, "public/programs/shell-engine.wasm"),
  resolve(root, "dist/product-shell/shell-engine.wasm"),
);
