import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const scratch = await mkdtemp(join(tmpdir(), "bash-web-prompt-tests-"));
try {
  const tests = (await readdir("src/prompt")).filter((file) => file.endsWith(".test.ts"));
  if (!tests.length) throw new Error("No prompt tests found");
  const entries = tests.map((file) => `src/prompt/${file}`).concat(["scripts/prompt-size.test.ts"]);
  await build({
    entryPoints: entries,
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outbase: ".",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const paths = entries.map((entry) => join(scratch, entry.replace(/\.ts$/, ".mjs")));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--test"].concat(paths), {
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
