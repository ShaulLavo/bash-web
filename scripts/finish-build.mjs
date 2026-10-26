import { copyFile } from "node:fs/promises";
await copyFile(
  new URL("./serve.mjs", import.meta.url),
  new URL("../dist/serve.mjs", import.meta.url),
);
// Vite consumes the prepared worker as an asset and replaces dist. Keep the stable
// library URL available as well as the hashed asset used by this demo build.
for (const worker of ["shell-worker", "fs-worker"]) {
  await copyFile(
    new URL(`../.build/browser/${worker}.js`, import.meta.url),
    new URL(`../dist/${worker}.js`, import.meta.url),
  );
}
for (const command of [
  "env",
  "cat",
  "grep",
  "head",
  "which",
  "ls",
  "mkdir",
  "rg",
  "sed",
  "seq",
  "sort",
  "tail",
  "uniq",
  "wc",
  "touch",
  "rm",
  "cp",
  "mv",
]) {
  await copyFile(
    new URL(`../public/programs/${command}.wasm`, import.meta.url),
    new URL(`../dist/${command}.wasm`, import.meta.url),
  );
}

await copyFile(
  new URL("../public/programs/rg.NOTICES.txt", import.meta.url),
  new URL("../dist/rg.NOTICES.txt", import.meta.url),
);
