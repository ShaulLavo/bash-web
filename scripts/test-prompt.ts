import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const child = spawn(process.execPath, ["--test", "--test-timeout=15000"].concat(paths), {
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Prompt tests exited ${code}`)),
    );
  });
} finally {
  await rm(scratch, { recursive: true, force: true });
}
