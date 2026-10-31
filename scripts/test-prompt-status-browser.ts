import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, type Browser } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, makeRepository } from "../src/prompt/git-test-helpers.ts";
import type {} from "../tests/helpers/prompt-status-browser.ts";

const scratch = await mkdtemp(join(tmpdir(), "bash-web-status-browser-"));
const output = process.argv[2];
interface Event {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly tid: number;
  readonly dur?: number;
  readonly args?: { readonly name?: string };
}
let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  const bundled = await build({
    entryPoints: ["tests/helpers/prompt-status-browser.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  await page.route("https://prompt.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      await route.fulfill({
        headers,
        contentType: "text/html",
        body: '<!doctype html><script type="module" src="/proof.js"></script>',
      });
      return;
    }
    if (path === "/proof.js") {
      await route.fulfill({
        headers,
        contentType: "text/javascript",
        body: bundled.outputFiles[0].text,
      });
      return;
    }
    const file = path.startsWith("/programs/") ? resolve(`public${path}`) : resolve(`dist${path}`);
    try {
      await route.fulfill({
        headers,
        contentType: path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        body: await readFile(file),
      });
    } catch {
      await route.fulfill({ status: 404, body: path });
    }
  });
  await page.goto("https://prompt.test/");
  await page.waitForFunction(() => Boolean(window.statusProof));
  const results = [];
  for (const count of [1000, 10000]) {
    const files = await fixture(count);
    const root = `/repo-${count}`;
    await page.evaluate(({ root, files }) => window.statusProof.prepare(root, files), {
      root,
      files,
    });
    const session = await page.context().newCDPSession(page);
    const events: Event[] = [];
    session.on("Tracing.dataCollected", (event) => {
      for (const raw of event.value) {
        const entry = traceEvent(raw);
        if (entry) events.push(entry);
      }
    });
    await session.send("Tracing.start", {
      categories: "toplevel,devtools.timeline",
      transferMode: "ReportEvents",
    });
    const measurement = await page.evaluate((root) => window.statusProof.measure(root), root);
    const complete = new Promise<void>((done) =>
      session.once("Tracing.tracingComplete", () => done()),
    );
    await session.send("Tracing.end");
    await complete;
    const main = new Set(
      events
        .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
        .map((event) => `${event.pid}:${event.tid}`),
    );
    const tasks = events
      .filter(
        (event) =>
          event.ph === "X" &&
          event.name.endsWith("RunTask") &&
          main.has(`${event.pid}:${event.tid}`),
      )
      .map((event) => (event.dur ?? 0) / 1000);
    assert.ok(tasks.length, "trace did not contain main-thread tasks");
    results.push({
      count,
      ...measurement,
      longestMainTaskMs: Math.max(...tasks),
      mainTasksOver10Ms: tasks.filter((value) => value >= 10).length,
    });
    await session.detach();
  }
  const paint = await page.evaluate(() => window.statusProof.paint("/repo-1000"));
  const typing = [];
  for (const mode of ["bash", "zsh"] as const)
    typing.push(
      await page.evaluate(({ mode }) => window.statusProof.typing("/repo-1000", mode), { mode }),
    );
  const result = {
    machine: "PC, Linux x86_64, Chromium with real Waffle memory filesystem",
    chromium: browser.version(),
    results,
    paint,
    typing,
  };
  console.log(JSON.stringify(result, null, 2));
  if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  for (const measured of results) {
    assert.ok(measured.cold < 2000, "cold status exceeded the background deadline");
    assert.ok(
      measured.warmMedian < (measured.count === 1000 ? 30 : 300),
      "warm status exceeded the design target",
    );
    assert.equal(
      measured.mainTasksOver10Ms,
      0,
      "status caused a main-thread task of at least 10 ms",
    );
    assert.equal(measured.hashes, measured.count, "warm turns rehashed confirmed-clean files");
  }
  assert.ok(
    paint.warmMedian < 3 && paint.warmP95 < 10,
    "ready fast facts waited for blocked background status",
  );
  await page.evaluate(() => window.statusProof.dispose());
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}

async function fixture(count: number): Promise<[string, string][]> {
  const root = await makeRepository(scratch, `repo-${count}`);
  const files: [string, string][] = [];
  for (let index = 0; index < count; index++) {
    const path = `d-${String(index % 100).padStart(3, "0")}/f-${String(index).padStart(5, "0")}`;
    const body = `tracked ${index}\n`;
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
    files.push([path, Buffer.from(body).toString("base64")]);
  }
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture");
  assert.equal(await git(root, "status", "--porcelain=v2"), "");
  for (const path of [".git/index", ".git/HEAD", ".git/config", ".git/refs/heads/main"])
    files.push([path, (await readFile(join(root, path))).toString("base64")]);
  return files;
}

function traceEvent(raw: unknown): Event | undefined {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("name" in raw) ||
    !("pid" in raw) ||
    !("tid" in raw) ||
    !("ph" in raw)
  )
    return undefined;
  if (
    typeof raw.name !== "string" ||
    typeof raw.pid !== "number" ||
    typeof raw.tid !== "number" ||
    typeof raw.ph !== "string"
  )
    return undefined;
  if (raw.name !== "thread_name" && !raw.name.endsWith("RunTask")) return undefined;
  const args = "args" in raw && raw.args && typeof raw.args === "object" ? raw.args : undefined;
  const name = args && "name" in args && typeof args.name === "string" ? args.name : undefined;
  return {
    name: raw.name,
    pid: raw.pid,
    tid: raw.tid,
    ph: raw.ph,
    dur: "dur" in raw && typeof raw.dur === "number" ? raw.dur : undefined,
    args: { name },
  };
}
