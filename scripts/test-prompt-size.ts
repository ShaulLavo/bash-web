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
  // Guard against real regressions with headroom for normal growth; measured 7,432 on October 31.
  // See pr5-objects/integration-e4ddbc49/size.log.
  if (sizes.eagerBytesGzip > 8_500)
    throw new Error(`prompt eager graph exceeds 8,500 bytes: ${sizes.eagerBytesGzip}`);
  // Guard against real regressions with headroom for normal growth; measured 1,487 on October 31.
  // See pr5-objects/integration-e4ddbc49/size.log.
  if (sizes.configIncrementalBytesGzip > 1_700)
    throw new Error(
      `prompt incremental config graph exceeds 1,700 bytes: ${sizes.configIncrementalBytesGzip}`,
    );
  // Guard against real regressions with headroom for normal growth; measured 7,098 and 4,763 on October 31.
  if (sizes.statusIncrementalBytesGzip > 5_500)
    throw new Error(`prompt status chunk exceeds 5,500 bytes: ${sizes.statusIncrementalBytesGzip}`);
  // Guard against real regressions with headroom for normal growth; measured 4,798 on October 31.
  // See pr5-objects/integration-e4ddbc49/size.log.
  if (sizes.objectsIncrementalBytesGzip > 5_500)
    throw new Error(
      `prompt objects chunk exceeds 5,500 bytes: ${sizes.objectsIncrementalBytesGzip}`,
    );
  // Guard against real regressions with headroom for normal growth; measured 18,480 on October 31.
  // See pr5-objects/integration-e4ddbc49/size.log.
  if (sizes.totalBytesGzip > 21_000)
    throw new Error(`prompt package exceeds 21,000 bytes: ${sizes.totalBytesGzip}`);
} finally {
  await rm(output, { recursive: true, force: true });
}
