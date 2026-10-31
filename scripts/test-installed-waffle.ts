import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readMetadata } from "./installed-waffle.ts";
import { assertBytesIdentity, verifyInstalledPrograms } from "./waffle-program-release.ts";

const root = resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function packageVersion(value: unknown): string {
  assert.ok(isRecord(value) && typeof value.version === "string");
  return value.version;
}

test("Bun-prepared Waffle resolves and shares its real Node exports", async () => {
  const selected = readMetadata(resolve(root, "sources.lock.json"));
  const programs = selected.wafflePrograms;
  assert.ok(isRecord(programs) && isRecord(programs.releaseManifest));
  const download = (url: unknown) => {
    assert.equal(typeof url, "string");
    return execFileSync(
      "curl",
      ["--fail", "--location", "--silent", "--show-error", "--max-time", "60", String(url)],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  };
  const closure = verifyInstalledPrograms(root, download(programs.releaseManifest.url));
  assert.ok(isRecord(selected.waffle));
  const runtimeArchive = download(selected.waffle.specifier);
  assertBytesIdentity(
    runtimeArchive,
    { bytes: runtimeArchive.length, sha256: selected.waffle.archiveSha256 },
    "selected runtime archive",
  );
  assert.equal(closure.directories.size, 8);
  console.log(`Verified ${closure.artifactCount} installed family artifacts before imports`);
  const sources: unknown = selected;
  assert.ok(isRecord(sources));
  const expectedVersion = packageVersion(sources.waffle);
  const installed: unknown = JSON.parse(
    await readFile(resolve(root, "node_modules/waffle/package.json"), "utf8"),
  );
  assert.equal(packageVersion(installed), expectedVersion);
  const expected = await realpath(resolve(root, "node_modules/waffle/dist/index.js"));
  assert.equal(import.meta.resolve("waffle"), pathToFileURL(expected).href);
  const imports = Array.from(closure.directories.keys()).concat([
    "@waffle/python/payload",
    "@waffle/python/install",
    "@waffle/python/launcher",
    "waffle-git/program",
  ]);
  execFileSync(
    "bun",
    ["--eval", "for (const path of process.argv.slice(1)) await import(path);"].concat(
      imports.map((name) => import.meta.resolve(name)),
    ),
    { stdio: "inherit" },
  );
  const node = await import("waffle");
  const runtime = await import("waffle/runtime");
  assert.equal(node.createRuntime, runtime.createRuntime);
  assert.equal(node.getVfsDescriptor("fast").mode, "fast");
  assert.equal(node.getVfsDescriptor("memory").persistent, false);
  assert.throws(() => node.getVfsDescriptor("safe"), { code: "UNSUPPORTED_VFS" });
});
