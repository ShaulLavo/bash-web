import { copyFile, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("./serve.ts", import.meta.url), "utf8");
await writeFile(new URL("../dist/serve.mjs", import.meta.url), stripTypeScriptTypes(source));
// Vite consumes the prepared worker as an asset and replaces dist. Keep the stable
// library URL available as well as the hashed asset used by this demo build.
for (const worker of ["shell-worker", "fs-worker"]) {
  await copyFile(
    new URL(`../.build/browser/${worker}.js`, import.meta.url),
    new URL(`../dist/${worker}.js`, import.meta.url),
  );
}
