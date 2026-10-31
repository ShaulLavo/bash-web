import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { test } from "node:test";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return record(value);
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  return value.map(text);
}

const root = resolve(import.meta.dirname, "..");
async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(resolve(root, path), "utf8"));
  return record(value);
}
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const sources = await readJson("sources.lock.json");
const sourceWaffle = record(sources.waffle);
const bunLock = await readFile(resolve(root, "bun.lock"), "utf8");

test("browser entry uses one required immutable Waffle peer and matching development install", () => {
  const peerDependencies = record(pkg.peerDependencies);
  const devDependencies = record(pkg.devDependencies);
  const peer = text(peerDependencies.waffle);
  const version = text(sourceWaffle.version);
  assert.equal(
    peer,
    `https://github.com/ShaulLavo/waffle/releases/download/waffle-v${version}/waffle-${version}.tgz`,
  );
  assert.equal(devDependencies.waffle, peer);
  assert.equal(sourceWaffle.specifier, peer);
  assert.match(text(sourceWaffle.revision), /^[0-9a-f]{40}$/);
  assert.match(text(sourceWaffle.archiveSha256), /^[0-9a-f]{64}$/);
  const peerMetadata = optionalRecord(pkg.peerDependenciesMeta);
  const waffleMetadata = optionalRecord(peerMetadata?.waffle);
  assert.notEqual(waffleMetadata?.optional, true);
  const packages = record(lock.packages);
  const rootPackage = record(packages[""]);
  assert.equal(record(rootPackage.peerDependencies).waffle, peer);
  assert.equal(record(rootPackage.devDependencies).waffle, peer);
  const lockedWaffle = record(packages["node_modules/waffle"]);
  const resolved = lockedWaffle.resolved;
  assert.equal(resolved, peer);
  const integrity = text(lockedWaffle.integrity);
  assert.match(integrity, /^sha512-/);
  assert.ok(bunLock.includes(integrity));
  assert.equal(lockedWaffle.version, sourceWaffle.version);
  assert.ok(strings(pkg.trustedDependencies).includes("waffle"));
  assert.ok(bunLock.includes(peer));
  assert.ok(bunLock.includes('"trustedDependencies"'));
  assert.equal(optionalRecord(pkg.allowScripts)?.[`waffle@${version}`], true);
  const exports = record(pkg.exports);
  assert.equal(exports["."], "./src/index.ts");
  assert.equal(exports["./shell"], "./src/shell.ts");
  assert.equal(exports["./prompt"], "./src/prompt/index.ts");
  assert.ok(strings(pkg.files).includes("src"));
});

test("the installed Waffle package declares the accepted source and export paths", async () => {
  const installed = await readJson("node_modules/waffle/package.json");
  assert.equal(installed.version, sourceWaffle.version);
  const rootExport = record(record(installed.exports)["."]);
  assert.equal(rootExport.browser, "./index.ts");
  assert.equal(rootExport.node, "./dist/index.js");
});

test("shipped shell source contains no vendored runtime or Bun program implementation", async () => {
  for (const path of ["third-party/bun-wasm", "src/browser/bun", "public/programs/bun.wasm"]) {
    await assert.rejects(stat(resolve(root, path)), { code: "ENOENT" });
  }
  assert.equal(optionalRecord(pkg.dependencies)?.["@bun-wasm/runtime"], undefined);
  assert.equal(optionalRecord(pkg.devDependencies)?.["@bun-wasm/runtime"], undefined);
  assert.equal(optionalRecord(pkg.peerDependencies)?.["@bun-wasm/runtime"], undefined);
});

test("worker preparation bundles the public Waffle FS worker and finish-build restores its assets", async (context) => {
  // This isolated packaging fixture owns only its scratch directory and child commands.
  // The existing dependency install is borrowed by a symlink, never copied or removed.
  const scratchRoot = resolve(root, ".build");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(resolve(scratchRoot, "browser-worker-package-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(resolve(scratch, "scripts"), { recursive: true });
  await mkdir(resolve(scratch, "src/runtime"), { recursive: true });
  await symlink(resolve(root, "node_modules"), resolve(scratch, "node_modules"), "dir");
  await writeFile(resolve(scratch, "src/runtime/worker.ts"), "export const shellWorker = true;\n");
  for (const script of ["build-worker.ts", "finish-build.ts", "serve.ts"]) {
    await copyFile(resolve(root, "scripts", script), resolve(scratch, "scripts", script));
  }
  const run = promisify(execFile);
  await run(process.execPath, [resolve(scratch, "scripts/build-worker.ts")], { timeout: 30000 });
  const prepared = new Map<string, Buffer>();
  for (const worker of ["shell-worker", "fs-worker"]) {
    const bytes = await readFile(resolve(scratch, `.build/browser/${worker}.js`));
    assert.ok(bytes.byteLength > 0);
    assert.deepEqual(await readFile(resolve(scratch, `dist/${worker}.js`)), bytes);
    prepared.set(worker, bytes);
  }
  // Vite replaces dist. Its hashed ?url asset is exercised by worker-assets.spec.ts;
  // finish-build must also restore the stable URLs for package consumers.
  await rm(resolve(scratch, "dist"), { recursive: true });
  await mkdir(resolve(scratch, "dist"));
  const finishBuild = resolve(scratch, "scripts/finish-build.ts");
  const umask = `data:text/javascript,${encodeURIComponent("process.umask(0o077);")}`;
  await run(process.execPath, ["--import", umask, finishBuild], { timeout: 30000 });
  for (const [worker, bytes] of prepared) {
    assert.deepEqual(await readFile(resolve(scratch, `dist/${worker}.js`)), bytes);
  }
  await run(process.execPath, ["--check", resolve(scratch, "dist/serve.mjs")], { timeout: 30000 });
  assert.equal((await stat(resolve(scratch, "dist/serve.mjs"))).mode & 0o777, 0o644);
});
