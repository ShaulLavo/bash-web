// Run with Bun from the repository root after building the WASI example.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { describeError, verifyPageDiagnostics } from "./diagnostics.mjs";

const root = resolve(import.meta.dir, "../../..");
const source = resolve(root, "shell/wasi-process/tests");
const fixture = process.env.WASI_PROCESS_FIXTURE;
assert.ok(fixture, "WASI_PROCESS_FIXTURE must name the built WASI example");
let scratch;
let server;
let browser;
let context;
let cleaning;
const diagnostics = [];
async function cleanup() {
  cleaning ??= closeResources();
  return cleaning;
}
async function closeResources() {
  let contextError;
  try {
    await context?.close();
  } catch (error) {
    contextError = error;
  }
  try {
    await browser?.close();
  } finally {
    await stopServerAndScratch();
  }
  if (contextError) throw contextError;
}
async function stopServerAndScratch() {
  server?.stop(true);
  if (scratch) await removeScratch(scratch);
}
for (const name of ["SIGINT", "SIGTERM"]) {
  process.once(name, () => void cleanup().finally(() => process.exit(1)));
}
try {
  scratch = await mkdtemp(join(tmpdir(), "wp-"));
  process.env.TMPDIR = scratch;
  const build = await Bun.build({
    entrypoints: [
      join(source, "browser-page.mjs"),
      join(source, "browser-worker.mjs"),
      resolve(root, "node_modules/waffle/browser/fs-worker.ts"),
      resolve(root, "src/runtime/worker.ts"),
    ],
    outdir: scratch,
    naming: "[name].js",
    target: "browser",
    format: "esm",
    splitting: false,
  });
  assert.ok(build.success, build.logs.join("\n"));
  const routes = new Map([
    [
      "/",
      "<script type='module'>import {execute} from '/page.js'; globalThis.execute = execute;</script>",
    ],
    ["/page.js", await readFile(join(scratch, "browser-page.js"))],
    ["/worker.js", await readFile(join(scratch, "browser-worker.js"))],
    ["/fs-worker.js", await readFile(join(scratch, "fs-worker.js"))],
    ["/shell-worker.js", await readFile(join(scratch, "worker.js"))],
    ["/fixture.wasm", await readFile(fixture)],
    ["/launch-probe.wasm", await readFile(join(dirname(fixture), "launch_probe.wasm"))],
  ]);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(routes.get(path) ?? "missing", {
        status: routes.has(path) ? 200 : 404,
        headers: {
          "Content-Type": path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".wasm")
              ? "application/wasm"
              : "text/html",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
      });
    },
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => diagnostics.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${describeError(error)}`));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => typeof globalThis.execute === "function");
  let deadline;
  try {
    const result = await Promise.race([
      page.evaluate((options) => globalThis.execute(options), {
        mode: process.env.WASI_PROCESS_MODE,
        injectBroker: process.env.WASI_PROCESS_INJECT_BROKER,
      }),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("WASI consumer did not finish in 60 seconds")),
          60_000,
        );
      }),
    ]);
    await injectPageDiagnostic(page, process.env.WASI_PROCESS_INJECT_PAGE);
    const identity = {};
    for (const name of ["process_fixture.wasm", "launch_probe.wasm"]) {
      const bytes = await readFile(join(dirname(fixture), name));
      identity[name] = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    console.log(JSON.stringify({ ...result, artifacts: identity }, null, 2));
  } catch (error) {
    console.error(diagnostics.join("\n"));
    throw error;
  } finally {
    clearTimeout(deadline);
  }
} finally {
  await cleanup();
  verifyPageDiagnostics(diagnostics);
}
console.log("wasi-process browser cleanup complete");

async function removeScratch(path) {
  await rm(path, { recursive: true, force: true });
  assert.equal(existsSync(path), false, `scratch survived cleanup: ${path}`);
  console.log(`removed browser scratch and profile: ${path}`);
}

async function injectPageDiagnostic(page, kind) {
  if (!kind) return;
  await page.evaluate(emitPageDiagnostic, kind);
}

async function emitPageDiagnostic(kind) {
  if (kind === "console") console.error("injected unexpected console error");
  if (kind === "pageerror")
    setTimeout(() => {
      throw new Error("injected unexpected page error");
    }, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
}
