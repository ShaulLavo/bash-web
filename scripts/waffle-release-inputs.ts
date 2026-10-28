import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return String(value);
}
const json = (path: string) => object(JSON.parse(readFileSync(path, "utf8")));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function waffleRelease(root: string) {
  const selected = object(json(resolve(root, "sources.lock.json")).waffle);
  const inputs = object(selected.buildInputs);
  const release = {
    revision: text(selected.revision),
    version: text(selected.version),
    specifier: text(selected.specifier),
    packagePath: text(inputs.packagePath),
    builderSha256: text(inputs.builderSha256),
    patchSha256: text(inputs.patchSha256),
  };
  assert.match(release.revision, /^[0-9a-f]{40}$/);
  assert.match(release.builderSha256, /^[0-9a-f]{64}$/);
  assert.match(release.patchSha256, /^[0-9a-f]{64}$/);
  assert.equal(release.packagePath, "packages/waffle");
  return release;
}

type Download = (url: string) => Uint8Array;
const downloadSource: Download = (url) =>
  execFileSync("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--max-time",
    "60",
    url,
  ]);

function pinnedSource(path: string, sha256: string, url: string, download: Download): void {
  if (existsSync(path)) {
    assert.equal(digest(readFileSync(path)), sha256, `Waffle input checksum mismatch: ${path}`);
    return;
  }
  const bytes = download(url);
  assert.equal(digest(bytes), sha256, `Waffle input checksum mismatch: ${url}`);
  mkdirSync(dirname(path), { recursive: true });
  const stage = mkdtempSync(resolve(dirname(path), ".waffle-input-"));
  try {
    writeFileSync(resolve(stage, "input"), bytes);
    renameSync(resolve(stage, "input"), path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function prepareWaffleBuildInputs(root: string, download: Download = downloadSource) {
  const release = waffleRelease(root);
  const pkg = json(resolve(root, "package.json"));
  assert.equal(
    object(pkg.devDependencies).waffle,
    release.specifier,
    "Waffle release pin mismatch",
  );
  assert.equal(object(pkg.peerDependencies).waffle, release.specifier, "Waffle peer pin mismatch");
  const installed = resolve(root, "node_modules/waffle");
  const metadata = json(resolve(installed, "package.json"));
  assert.equal(metadata.name, "waffle");
  assert.equal(metadata.version, release.version, "Installed Waffle release mismatch");
  assert.equal(
    digest(readFileSync(resolve(installed, "scripts/build-wasi-libc.sh"))),
    release.builderSha256,
    "Installed Waffle builder differs from selected source",
  );
  const directory = resolve(root, ".build/waffle-inputs", release.revision, release.packagePath);
  const files = [
    ["scripts/build-wasi-libc.sh", release.builderSha256],
    ["patches/wasi-libc/preopen-scan.patch", release.patchSha256],
  ];
  for (const [path, sha256] of files) {
    pinnedSource(
      resolve(directory, path),
      sha256,
      `https://raw.githubusercontent.com/ShaulLavo/waffle/${release.revision}/${release.packagePath}/${path}`,
      download,
    );
  }
  return {
    builder: resolve(directory, files[0][0]),
    patch: resolve(directory, files[1][0]),
    revision: release.revision,
  };
}
