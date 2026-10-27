import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const directory = resolve(`.build/git-consumer-${randomUUID()}`);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = resolve(directory, `.${path === "/" ? "/index.html" : path}`);
  if (!file.startsWith(directory + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});

try {
  await mkdir(directory, { recursive: true });
  await copyFile(
    "node_modules/waffle-git/dist/git-command.js",
    resolve(directory, "git-command.js"),
  );
  await build({
    entryPoints: {
      "git-tests": "tests/helpers/git-consumer.ts",
      "fs-worker": "waffle/browser/fs-worker",
    },
    outdir: directory,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "esnext",
    chunkNames: "[name]-[hash]",
    plugins: [
      {
        name: "family-git-backend",
        setup(builder) {
          builder.onResolve({ filter: /\/dist\/git-command\.js$/ }, () => ({
            path: "./git-command.js",
            external: true,
          }));
        },
      },
    ],
  });
  await writeFile(
    resolve(directory, "index.html"),
    '<!doctype html><script type="module" src="/git-tests.js"></script>',
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => !!window.gitConsumerTest);
  assert.deepEqual(await page.evaluate(() => window.gitConsumerTest.setup()), {
    admissions: 0,
    disposed: false,
  });
  assert.equal(
    requests.some((url) => new URL(url).pathname === "/git-command.js"),
    false,
    "install loads no Git backend",
  );
  for (const argv of [
    ["--version"],
    ["init"],
    ["add", "story"],
    ["commit", "-m", "base"],
    ["log"],
    ["status"],
  ]) {
    if (argv[0] === "add")
      await page.evaluate(() => window.gitConsumerTest.write("story", "base\n"));
    const result: { status: number; stdout: string; stderr: string } = await page.evaluate(
      (args) => window.gitConsumerTest.run(args),
      argv,
    );
    assert.equal(result.status, 0, `${argv.join(" ")}: ${result.stderr}`);
    if (argv[0] === "log") assert.match(result.stdout, /base/);
    if (argv[0] === "status") assert.equal(result.stdout, "");
  }
  assert.equal(
    requests.filter((url) => new URL(url).pathname === "/git-command.js").length,
    1,
    "all local commands share one lazy backend",
  );
  assert.deepEqual(await page.evaluate(() => window.gitConsumerTest.release()), {
    disposed: false,
    admissions: 0,
    caller: "yes",
  });
  assert.deepEqual(errors, []);
} finally {
  try {
    await page?.evaluate(() => window.gitConsumerTest?.cleanup());
  } finally {
    await browser?.close();
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    await rm(directory, { recursive: true, force: true });
  }
}
