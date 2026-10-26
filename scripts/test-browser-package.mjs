import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const sources = await readJson("sources.lock.json");
const bunLock = await readFile(resolve(root, "bun.lock"), "utf8");

test("browser entry uses one required immutable Waffle peer and matching development install", () => {
  const peer = pkg.peerDependencies.waffle;
  assert.match(peer, /^git\+https:\/\/github\.com\/ShaulLavo\/waffle\.git#[0-9a-f]{40}$/);
  assert.equal(pkg.devDependencies.waffle, peer);
  assert.equal(sources.waffle.specifier, peer);
  assert.equal(sources.waffle.revision, peer.split("#")[1]);
  assert.notEqual(pkg.peerDependenciesMeta?.waffle?.optional, true);
  assert.equal(lock.packages[""].peerDependencies.waffle, peer);
  assert.equal(lock.packages[""].devDependencies.waffle, peer);
  // npm records the same immutable Git identity using its canonical SSH transport.
  // Preserve that honest lockfile instead of forcing its text to match Bun's pin.
  const resolved = lock.packages["node_modules/waffle"].resolved;
  assert.match(
    resolved,
    /^git\+(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)ShaulLavo\/waffle\.git#[0-9a-f]{40}$/,
  );
  assert.equal(resolved.split("#")[1], sources.waffle.revision);
  assert.equal(lock.packages["node_modules/waffle"].version, sources.waffle.version);
  assert.ok(pkg.trustedDependencies.includes("waffle"));
  assert.ok(bunLock.includes(peer));
  assert.ok(bunLock.includes('"trustedDependencies"'));
  assert.equal(pkg.allowScripts?.[`waffle@${sources.waffle.version}`], true);
  assert.equal(pkg.exports["."], "./src/index.ts");
  assert.equal(pkg.exports["./shell"], "./src/shell.ts");
  assert.ok(pkg.files.includes("src"));
});

test("the installed Waffle package declares the accepted source and export paths", async () => {
  const installed = await readJson("node_modules/waffle/package.json");
  assert.equal(installed.version, sources.waffle.version);
  assert.equal(installed.exports["."].browser, "./index.ts");
  assert.equal(installed.exports["."].node, "./dist/index.js");
});

test("shipped shell source contains no vendored runtime or Bun program implementation", async () => {
  for (const path of ["third-party/bun-wasm", "src/browser/bun", "public/programs/bun.wasm"]) {
    await assert.rejects(stat(resolve(root, path)), { code: "ENOENT" });
  }
  assert.equal(pkg.dependencies?.["@bun-wasm/runtime"], undefined);
  assert.equal(pkg.devDependencies?.["@bun-wasm/runtime"], undefined);
  assert.equal(pkg.peerDependencies?.["@bun-wasm/runtime"], undefined);
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
  for (const script of ["build-worker.mjs", "finish-build.mjs", "serve.mjs"]) {
    await copyFile(resolve(root, "scripts", script), resolve(scratch, "scripts", script));
  }
  const run = promisify(execFile);
  await run(process.execPath, [resolve(scratch, "scripts/build-worker.mjs")], { timeout: 30000 });
  const prepared = new Map();
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
  const programs = ["cat", "grep", "mkdir", "seq", "rg"].map((name) => [
    name,
    Buffer.from(`${name}-program`),
  ]);
  await mkdir(resolve(scratch, "public/programs"), { recursive: true });
  for (const [name, bytes] of programs)
    await writeFile(resolve(scratch, `public/programs/${name}.wasm`), bytes);
  await writeFile(resolve(scratch, "public/programs/rg.NOTICES.txt"), "ripgrep notices");
  await run(process.execPath, [resolve(scratch, "scripts/finish-build.mjs")], { timeout: 30000 });
  for (const [worker, bytes] of prepared) {
    assert.deepEqual(await readFile(resolve(scratch, `dist/${worker}.js`)), bytes);
  }
  assert.equal(await readFile(resolve(scratch, "dist/rg.NOTICES.txt"), "utf8"), "ripgrep notices");
  for (const [name, bytes] of programs)
    assert.deepEqual(await readFile(resolve(scratch, `dist/${name}.wasm`)), bytes);
});
