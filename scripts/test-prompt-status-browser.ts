import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type CDPSession } from "@playwright/test";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname, cpus, platform, release, arch } from "node:os";
import { join, resolve } from "node:path";
import { git, makeRepository } from "../src/prompt/git-test-helpers.ts";
import type { FixtureChoice } from "../tests/helpers/prompt-status-browser.ts";

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
interface Fixture {
  readonly storage: "loose" | "packed";
  readonly root: string;
  readonly files: [string, string][];
  readonly choices: readonly [FixtureChoice, FixtureChoice];
  readonly head: string;
  readonly commits: number;
  readonly trackedPaths: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly packs: readonly string[];
}
let browser: Browser | undefined;
let page: Page | undefined;
try {
  browser = await chromium.launch();
  const activePage = await browser.newPage();
  page = activePage;
  await openProof(page);
  const production = await productionPair(page);
  const results = [];
  for (const count of [1000, 10000]) {
    const files = await fixture(count);
    const root = `/repo-${count}`;
    await page.evaluate(({ root, files }) => window.statusProof.prepare(root, files), {
      root,
      files,
    });
    const measurement = await traced(page, () =>
      activePage.evaluate((root) => window.statusProof.measure(root), root),
    );
    results.push({ count, ...measurement.value, ...measurement.tasks });
    await page.evaluate((root) => window.statusProof.forget(root), root);
  }
  const controls = await interactionControls(page, production[0]);
  const result = {
    experiment: "Bounded baseline, no speedup claim or new timing budget",
    machine: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    chromium: browser.version(),
    browser: {
      executable: chromium.executablePath(),
      headless: true,
      filesystem: "real Waffle memory filesystem",
    },
    moduleLoadOrder: [
      "One esbuild ESM bundle, splitting disabled; createPrompt and the worktree-only GitStatusSource are static imports",
      "Loose validation runs before measured providers; production objects initialize lazily during validation",
      "Loose measurement, packed validation and measurement, old worktree loops, then interaction controls",
      "First-provider cold samples are not cold modules, process, operating-system cache, or filesystem samples",
    ],
    timing: {
      paintMs: 15,
      backgroundMs: 2000,
      completionWatchdogMs: 10000,
      warmSamples: 10,
      taskWindow:
        "CDP around each render/completion call; excludes fixture import and awaited ref mutation/readback",
    },
    production,
    worktreeOnly: results,
    ...controls,
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
  for (const paint of controls.paint)
    assert.ok(
      paint.warmMedian < 3 && paint.warmP95 < 10,
      "ready fast facts waited for blocked background status",
    );
} finally {
  try {
    await page?.evaluate(() => window.statusProof?.dispose());
  } finally {
    try {
      await browser?.close();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function openProof(page: Page) {
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
}
async function traced<T>(page: Page, operation: () => Promise<T>) {
  const session = await page.context().newCDPSession(page);
  const events: Event[] = [];
  session.on("Tracing.dataCollected", (event) => {
    for (const raw of event.value) {
      const entry = traceEvent(raw);
      if (entry) events.push(entry);
    }
  });
  let tracing = false;
  try {
    await session.send("Tracing.start", {
      categories: "toplevel,devtools.timeline",
      transferMode: "ReportEvents",
    });
    tracing = true;
    const value = await operation();
    await endTrace(session);
    tracing = false;
    return { value, tasks: taskTimes(events) };
  } finally {
    try {
      if (tracing) await endTrace(session);
    } finally {
      await session.detach();
    }
  }
}
async function endTrace(session: CDPSession) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const complete = new Promise<void>((done, reject) => {
    session.once("Tracing.tracingComplete", () => done());
    timer = setTimeout(() => reject(new Error("trace completion timed out")), 10000);
  });
  try {
    await session.send("Tracing.end");
    await complete;
  } finally {
    clearTimeout(timer);
  }
}
function taskTimes(events: readonly Event[]) {
  const main = new Set(
    events
      .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
      .map((event) => `${event.pid}:${event.tid}`),
  );
  const mainTaskMs = events
    .filter(
      (event) =>
        event.ph === "X" && event.name.endsWith("RunTask") && main.has(`${event.pid}:${event.tid}`),
    )
    .map((event) => (event.dur ?? 0) / 1000);
  assert.ok(mainTaskMs.length, "trace did not contain main-thread tasks");
  return {
    mainTaskMs,
    longestMainTaskMs: Math.max(...mainTaskMs),
    mainTasksOver10Ms: mainTaskMs.filter((value) => value >= 10).length,
  };
}
async function productionPair(page: Page) {
  const started = performance.now();
  const loose = await productionFixture();
  const packedRoot = join(scratch, "production-packed");
  await cp(join(scratch, "production-loose"), packedRoot, { recursive: true });
  await git(packedRoot, "repack", "-ad");
  await git(packedRoot, "prune-packed");
  const packed = await describeFixture(packedRoot, "packed", loose.choices);
  assert.equal(packed.head, loose.head);
  const nativeSetupMs = performance.now() - started;
  const records = [];
  for (const fixture of [loose, packed]) {
    records.push(await measureProduction(page, fixture, nativeSetupMs));
    if (output)
      await writeFile(`${output}.production.json`, `${JSON.stringify(records, null, 2)}\n`);
    if (fixture.storage === "packed")
      await page.evaluate((root) => window.statusProof.forget(root), fixture.root);
  }
  return records;
}
async function measureProduction(page: Page, fixture: Fixture, nativeSetupMs: number) {
  const { files, ...identity } = fixture;
  const importStarted = performance.now();
  await page.evaluate(({ root, files }) => window.statusProof.prepare(root, files), {
    root: fixture.root,
    files,
  });
  const importMs = performance.now() - importStarted;
  console.error(`Imported complete ${fixture.storage} production fixture.`);
  const validation = await page.evaluate(
    ({ root, choices }) => window.statusProof.validateProduction(root, choices),
    fixture,
  );
  for (const sample of validation.samples) checkReads(sample.reads, fixture.storage);
  console.error(`Validated both native markers for ${fixture.storage} production fixture.`);
  await page.evaluate((root) => window.statusProof.beginProduction(root), fixture.root);
  const samples = [];
  for (let turn = 1; turn <= 11; turn++) {
    const choice = fixture.choices[(turn - 1) % 2];
    assert.ok(choice);
    const refReadback = await page.evaluate(
      ({ root, choice }) => window.statusProof.selectUpstream(root, choice),
      {
        root: fixture.root,
        choice,
      },
    );
    const measured = await traced(page, () =>
      page.evaluate(({ root, choice, turn }) => window.statusProof.production(root, choice, turn), {
        root: fixture.root,
        choice,
        turn,
      }),
    );
    checkReads(measured.value.reads, fixture.storage);
    assert.equal(measured.value.marker, choice.marker);
    for (const value of [measured.value.firstPaintMs, measured.value.completionMs])
      assert.ok(Number.isFinite(value) && value >= 0);
    samples.push({ ...measured.value, refReadback, ...measured.tasks });
  }
  return {
    ...identity,
    provider: "exported createPrompt, production defaults",
    workload: "Warm worktree and object reads with alternating upstream tip; one provider per arm",
    nativeSetupMs,
    importMs,
    validation,
    cold: samples[0],
    warm: samples.slice(1),
    warmCompletionMs: distribution(samples.slice(1).map((sample) => sample.completionMs)),
    warmFirstPaintMs: distribution(samples.slice(1).map((sample) => sample.firstPaintMs)),
  };
}
function checkReads(
  reads: Awaited<ReturnType<Window["statusProof"]["production"]>>["reads"],
  storage: Fixture["storage"],
) {
  assert.ok(
    reads.looseObject.bytes + reads.pack.bytes + reads.packIndex.bytes > 0,
    "no object input bytes",
  );
  if (storage !== "packed") return;
  assert.ok(reads.pack.reads > 0 && reads.pack.bytes > 0, "packed measurement did not read a pack");
  assert.ok(
    reads.packIndex.reads > 0 && reads.packIndex.bytes > 0,
    "packed measurement did not read a pack index",
  );
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  assert.equal(values.length, 10);
  return { median: (values[4] + values[5]) / 2, p95: values[9] };
}
async function interactionControls(
  page: Page,
  fixture: Awaited<ReturnType<typeof measureProduction>>,
) {
  const root = fixture.root;
  const choice = fixture.choices[0];
  await page.evaluate(({ root, choice }) => window.statusProof.selectUpstream(root, choice), {
    root,
    choice,
  });
  const paint = [];
  const typing = [];
  for (const path of [`${root}/d-000/f-00000`, fixture.validation.objectPath]) {
    paint.push(
      await page.evaluate(
        ({ root, path, expected }) => window.statusProof.paint(root, path, expected),
        { root, path, expected: choice.marker },
      ),
    );
    for (const mode of ["bash", "zsh"] as const)
      typing.push(
        await page.evaluate(
          ({ root, path, expected, mode }) => window.statusProof.typing(root, mode, path, expected),
          { root, path, expected: `[!1+1⇕${choice.ahead}/${choice.behind}] `, mode },
        ),
      );
  }
  return { paint, typing };
}
async function fixture(count: number): Promise<[string, string][]> {
  const root = await makeRepository(scratch, `repo-${count}`);
  await trackedFiles(root, count);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture");
  assert.equal(await git(root, "status", "--porcelain=v2"), "");
  await git(root, "repack", "-ad");
  await git(root, "prune-packed");
  console.error(`Prepared complete ${count}-path worktree-only fixture with packed objects.`);
  return transferFiles(root);
}
async function trackedFiles(root: string, count: number) {
  for (let index = 0; index < count; index++) {
    const path = `d-${String(index % 100).padStart(3, "0")}/f-${String(index).padStart(5, "0")}`;
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), `tracked ${index}\n`);
  }
}
async function productionFixture(): Promise<Fixture> {
  const root = await makeRepository(scratch, "production-loose");
  await trackedFiles(root, 1000);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await git(root, "branch", "upstream");
  await git(root, "commit", "--allow-empty", "-qm", "main");
  await git(root, "switch", "-q", "upstream");
  await git(root, "commit", "--allow-empty", "-qm", "upstream one");
  const one = await git(root, "rev-parse", "HEAD");
  await git(root, "branch", "saved-upstream-one", one);
  await git(root, "commit", "--allow-empty", "-qm", "upstream two");
  const two = await git(root, "rev-parse", "HEAD");
  await git(root, "branch", "saved-upstream-two", two);
  await git(root, "switch", "-q", "main");
  await git(root, "config", "branch.main.remote", ".");
  await git(root, "config", "branch.main.merge", "refs/heads/upstream");
  await writeFile(join(root, "staged"), "staged addition\n");
  await git(root, "add", "staged");
  const choices: readonly [FixtureChoice, FixtureChoice] = [
    await oracle(root, one, 1),
    await oracle(root, two, 2),
  ];
  return describeFixture(root, "loose", choices);
}
async function oracle(root: string, oid: string, expectedBehind: number): Promise<FixtureChoice> {
  await git(root, "update-ref", "refs/heads/upstream", oid);
  assert.equal(await git(root, "rev-parse", "@{upstream}"), oid);
  const staged = (await git(root, "diff", "--cached", "--no-renames", "--name-only", "-z"))
    .split("\0")
    .filter(Boolean).length;
  const [ahead, behind] = (
    await git(root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
  )
    .split(/\s+/u)
    .map(Number);
  assert.equal(staged, 1);
  assert.equal(ahead, 1);
  assert.equal(behind, expectedBehind);
  return { oid, staged, ahead, behind, marker: `[+${staged}⇕${ahead}/${behind}] ` };
}
async function describeFixture(
  root: string,
  storage: Fixture["storage"],
  choices: Fixture["choices"],
): Promise<Fixture> {
  for (const choice of choices)
    assert.deepEqual(await oracle(root, choice.oid, choice.behind), choice);
  await git(root, "fsck", "--full", "--no-reflogs");
  const commits = Number(await git(root, "rev-list", "--all", "--count"));
  assert.ok(commits <= 20);
  const files = await transferFiles(root);
  const objects = files.filter(([path]) => path.startsWith(".git/objects/"));
  const packs = objects.map(([path]) => path).filter((path) => /\.(?:pack|idx)$/u.test(path));
  assert.equal(
    storage === "packed",
    packs.some((path) => path.endsWith(".pack")),
  );
  assert.equal(
    storage === "packed",
    packs.some((path) => path.endsWith(".idx")),
  );
  if (storage === "packed") {
    const tips = choices.map((choice) => choice.oid).concat(await git(root, "rev-parse", "HEAD"));
    for (const oid of tips)
      assert.ok(
        !objects.some(([path]) => path === `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`),
        "packed tips must not have loose copies",
      );
  }
  assert.ok(!files.some(([path]) => path.endsWith("/alternates")));
  const bytes = files.reduce((sum, [, body]) => sum + Buffer.from(body, "base64").length, 0);
  const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const trackedPaths = (await git(root, "ls-files", "-z")).split("\0").filter(Boolean).length;
  assert.equal(trackedPaths, 1001);
  assert.equal(commits, 4);
  return {
    storage,
    root: `/production-${storage}`,
    files,
    choices,
    head: await git(root, "rev-parse", "HEAD"),
    commits,
    trackedPaths,
    bytes,
    sha256,
    packs,
  };
}
async function transferFiles(root: string, relative = ""): Promise<[string, string][]> {
  const files: [string, string][] = [];
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await transferFiles(root, path)));
    else {
      assert.ok(entry.isFile(), "fixture transfer accepts only files and directories");
      files.push([path, (await readFile(join(root, path))).toString("base64")]);
    }
  }
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
