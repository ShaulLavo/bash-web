import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { build } from "esbuild";
import { chromium, firefox, type Page } from "playwright";
import cases from "../tests/helpers/grep-usage-cases.json" with { type: "json" };
import receipt from "../shell/utilities/grep.source.json" with { type: "json" };

function observeWorkerStops(page: Page) {
  const stopped: Promise<void>[] = [];
  page.on("worker", (worker) => {
    stopped.push(new Promise<void>((resolve) => worker.once("close", () => resolve())));
  });
  return async () => {
    await Promise.all(stopped);
    assert.equal(page.workers().length, 0, "all shell, grep and filesystem workers must exit");
  };
}

// This is a separate, explicit grep control set. It neither reads nor updates
// the shell compatibility floor or any frozen oracle.
const lock = await readFile(new URL("../shell/Cargo.lock", import.meta.url), "utf8");
assert.ok(
  lock.includes(
    `name = "regex"\nversion = "${receipt.upstream.version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${receipt.upstream.archiveSha256}"`,
  ),
);
const license = await readFile(new URL(`../${receipt.upstream.licenseFile}`, import.meta.url));
assert.equal(createHash("sha256").update(license).digest("hex"), receipt.upstream.licenseSha256);
const oracle = execFileSync("grep", ["--version"], { encoding: "utf8" }).split("\n")[0];
assert.match(oracle, /GNU grep/);
const scratch = await mkdtemp(resolve(tmpdir(), "grep-usage-"));
try {
  for (const example of cases) {
    const actual = spawnSync("bash", ["--noprofile", "--norc", "-c", example.script], {
      cwd: scratch,
      env: { PATH: process.env.PATH, LC_ALL: "C" },
      encoding: "utf8",
    });
    assert.ifError(actual.error);
    assert.equal(actual.status, example.status, example.name);
    assert.equal(actual.stdout, example.stdout, example.name);
    assert.equal(actual.stderr.length > 0, example.stderrPresent, example.name);
  }
  console.log(`${oracle}: ${cases.length} explicit usage controls passed`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
if (process.argv.includes("--native-only")) process.exit(0);

await build({
  entryPoints: ["tests/helpers/grep-usage-browser.ts"],
  outfile: "dist/grep-usage.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
});
await writeFile(
  "dist/grep-usage.html",
  '<!doctype html><script type="module" src="/grep-usage.js"></script>',
);
const root = resolve("dist");
const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  try {
    const path = resolve(root, `.${new URL(request.url ?? "/", "http://localhost").pathname}`);
    assert.ok(path.startsWith(root + sep));
    response.setHeader(
      "Content-Type",
      path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    );
    if (path.endsWith(".html")) response.setHeader("Content-Type", "text/html");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const browserType of [chromium, firefox]) {
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const workersStopped = observeWorkerStops(page);
      await page.goto(`http://127.0.0.1:${address.port}/grep-usage.html`);
      await page.waitForFunction(() => typeof window.grepUsage === "function");
      const actual = await page.evaluate(
        (scripts) => window.grepUsage(scripts),
        cases.map((c) => c.script),
      );
      assert.equal(actual.before, 0, "installation must remain lazy");
      assert.equal(actual.after, 1, "grep loads once on first use");
      assert.deepEqual(
        actual.results,
        cases.map(({ status, stdout, stderrPresent }) => ({ status, stdout, stderrPresent })),
      );
      assert.equal(actual.missing, 127);
      assert.equal(actual.ownerAlive, "alive");
      await workersStopped();
      console.log(
        `${browserType.name()}: ${cases.length} Waffle usage controls, lazy load, borrowed runtime and worker cleanup passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
