// Loads the pinned libghostty-vt from `.sources/ghostty-webgpu` (`npm run sources:browser`)
// so display tests replay editor bytes into the same terminal the playground runs.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const terminal = resolve(import.meta.dirname, "../.sources/ghostty-webgpu");

type Runtime = typeof import("../.sources/ghostty-webgpu/src/core/runtime.ts").GhosttyRuntime;

export async function ghosttyRuntime() {
  const entry = resolve(terminal, "src/core/runtime.ts");
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    // Asset URLs resolve against the source file; the wasm bytes are passed explicitly.
    define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
  });
  const source = Buffer.from(bundle.outputFiles[0]!.contents).toString("base64");
  const { GhosttyRuntime }: { GhosttyRuntime: Runtime } = await import(
    `data:text/javascript;base64,${source}`
  );
  return GhosttyRuntime.create({
    wasm: await readFile(resolve(terminal, "ghostty-vt.wasm")),
    bridge: await readFile(resolve(terminal, "bridge.wasm")),
  });
}

export async function ghosttyRevision() {
  const provenance = JSON.parse(
    await readFile(resolve(terminal, "ghostty-vt.provenance.json"), "utf8"),
  );
  return String(provenance.source.revision);
}
