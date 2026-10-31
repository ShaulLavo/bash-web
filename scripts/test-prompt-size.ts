import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptSize } from "./prompt-size.ts";

const output = await mkdtemp(join(tmpdir(), "bash-web-prompt-size-"));
try {
  const { metafile } = await build({
    entryPoints: ["src/prompt/index.ts"],
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    outdir: output,
    metafile: true,
    logLevel: "silent",
  });
  const entries = await Promise.all(
    Object.keys(metafile.outputs).map(
      async (file) => [file, gzipSync(await readFile(file)).byteLength] as const,
    ),
  );
  const sizes = promptSize(metafile, new Map(entries));
  console.log(JSON.stringify({ entries, ...sizes }));
  if (sizes.eagerBytesGzip > 7_000)
    throw new Error(`prompt eager graph exceeds 7,000 bytes: ${sizes.eagerBytesGzip}`);
  if (sizes.configIncrementalBytesGzip > 1_500)
    throw new Error(
      `prompt incremental config graph exceeds 1,500 bytes: ${sizes.configIncrementalBytesGzip}`,
    );
  if (sizes.totalBytesGzip > 18_000)
    throw new Error(`prompt package exceeds 18,000 bytes: ${sizes.totalBytesGzip}`);
} finally {
  await rm(output, { recursive: true, force: true });
}
