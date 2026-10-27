import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium, type Browser } from "@playwright/test";
import type * as FindApi from "../tests/helpers/find-browser-api.ts";
import { findCases, findOutput } from "../tests/helpers/find-cases.ts";
import { findOracle } from "./find-oracle.ts";

const output = resolve(".build/find-browser");
const release = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");

test(
  "find traversal and predicates match GNU in a real Waffle browser",
  { timeout: 60000 },
  async (context) => {
    let browser: Browser | undefined;
    const assets = new Map([
      ["/api.js", resolve(output, "api.js")],
      ["/shell-worker.js", resolve("dist/shell-worker.js")],
      ["/fs-worker.js", resolve("dist/fs-worker.js")],
      ["/shell-runtime.wasm", resolve(release, "shell-runtime.wasm")],
      ["/find.wasm", resolve(release, "find.wasm")],
    ]);
    const server = createServer(async (request, response) => {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><meta charset=utf-8><title>Find acceptance</title>");
        return;
      }
      const path = assets.get(request.url ?? "");
      if (!path) {
        response.writeHead(404).end();
        return;
      }
      try {
        response.setHeader(
          "Content-Type",
          path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        response.end(await readFile(path));
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    context.after(async () => {
      await browser?.close();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await rm(output, { recursive: true, force: true });
    });
    await mkdir(output, { recursive: true });
    await build({
      entryPoints: ["tests/helpers/find-browser-api.ts"],
      outfile: resolve(output, "api.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "esnext",
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const closedWorkers: Promise<void>[] = [];
    page.on("worker", (worker) => closedWorkers.push(worker.waitForEvent("close")));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const oracle = await findOracle(context);
    for (const example of findCases) {
      const expected = await oracle(example.script);
      const actual = await page.evaluate(async (script) => {
        const api: typeof FindApi = await import(new URL("/api.js", location.href).href);
        return api.checkFind(script);
      }, example.script);
      assert.equal(actual.status, expected.status, `${example.name}: ${actual.diagnostic}`);
      assert.deepEqual(
        findOutput(Uint8Array.from(actual.stdout), example.records),
        findOutput(expected.stdout, example.records),
        example.name,
      );
      assert.equal(actual.diagnostic.length > 0, expected.stderr.length > 0, example.name);
      assert.equal(actual.loads, 1);
      assert.equal(actual.removed, true);
      assert.equal(actual.ownerAlive, true);
      await Promise.all(closedWorkers);
      assert.equal(page.workers().length, 0, `${example.name}: leaked worker`);
    }
  },
);
