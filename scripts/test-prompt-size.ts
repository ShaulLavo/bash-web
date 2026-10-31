import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const output = await mkdtemp(join("/work/tmp", "bash-web-prompt-size-"));
try {
  await build({
    entryPoints: ["src/prompt/index.ts"],
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    outdir: output,
    metafile: true,
    logLevel: "silent",
  });
  const files = (await readdir(output)).filter((file) => file.endsWith(".js"));
  const entries = await Promise.all(
    files.map(
      async (file) => [file, gzipSync(await readFile(join(output, file))).byteLength] as const,
    ),
  );
  const sizes = new Map(entries);
  const eager = sizes.get("index.js") ?? 0;
  const configChunk = entries.find(([file]) => file.startsWith("file-"))?.[1] ?? 0;
  const total = entries.reduce((sum, [, size]) => sum + size, 0);
  console.log(
    JSON.stringify({
      entries,
      eagerBytesGzip: eager,
      configChunkBytesGzip: configChunk,
      totalBytesGzip: total,
    }),
  );
  if (eager > 7_000) throw new Error(`prompt eager bundle exceeds 7,000 bytes: ${eager}`);
  if (configChunk > 1_500)
    throw new Error(`prompt config chunk exceeds 1,500 bytes: ${configChunk}`);
  if (total > 18_000) throw new Error(`prompt package exceeds 18,000 bytes: ${total}`);
} finally {
  await rm(output, { recursive: true, force: true });
}
