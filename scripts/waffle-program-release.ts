import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { assertProgramRuntimeIdentity } from "./check-waffle-release.ts";
import { readMetadata, verifyInstalledWaffle } from "./installed-waffle.ts";
import {
  assertPackageHostInterface,
  metadataRecord,
  type HostInterface,
} from "./waffle-host-interface.ts";

export function assertBytesIdentity(bytes: Uint8Array, expected: unknown, source: string): void {
  const identity = metadataRecord(expected);
  assert.equal(bytes.byteLength, identity.bytes, `${source}: byte length mismatch`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    identity.sha256,
    `${source}: SHA-256 mismatch`,
  );
}

function readProgramRelease(root: string, bytes: Uint8Array, required: HostInterface) {
  const selected = metadataRecord(readMetadata(resolve(root, "sources.lock.json")).wafflePrograms);
  assertBytesIdentity(bytes, selected.releaseManifest, "program release manifest");
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const release = metadataRecord(value);
  assert.equal(release.schema, "waffle-program-release/2");
  assert.equal(release.tagState, "tagged");
  assert.equal(release.dirty, false);
  assert.equal(release.version, selected.version);
  assert.equal(release.sourceCommit, selected.revision);
  assertPackageHostInterface(release.runtime, required, "program release runtime");
  assertProgramRuntimeIdentity(release.runtime, selected.runtime);
  assert.ok(Array.isArray(release.packages));
  for (const value of release.packages) {
    const pkg = metadataRecord(value);
    assertPackageHostInterface(pkg, required, `program release ${String(pkg.name)}`);
  }
  return release;
}

function assertProgramDependencies(metadata: unknown, releasePackage: unknown): void {
  const pkg = metadataRecord(metadata);
  const release = metadataRecord(releasePackage);
  const expected = {
    ...metadataRecord(release.closureDependencies),
    ...metadataRecord(release.registryDependencies),
  };
  assert.deepEqual(
    pkg.dependencies ?? {},
    expected,
    `${String(pkg.name)}: changed dependency edges`,
  );
}

function artifactPath(directory: string, path: unknown): string {
  assert.equal(typeof path, "string");
  const file = resolve(directory, String(path));
  const suffix = relative(directory, file);
  assert.ok(suffix && !suffix.startsWith("..") && !isAbsolute(suffix), "Artifact escapes package");
  return file;
}

export function verifyInstalledPrograms(root: string, bytes: Uint8Array) {
  const installed = verifyInstalledWaffle(root);
  const release = readProgramRelease(root, bytes, installed.required);
  assert.ok(Array.isArray(release.packages));
  assert.equal(release.packages.length, installed.directories.size);
  const locks = metadataRecord(readMetadata(resolve(root, "package-lock.json")).packages);
  const names = new Set<string>();
  let artifactCount = 0;
  for (const value of release.packages) {
    const pkg = metadataRecord(value);
    assert.equal(typeof pkg.name, "string");
    const name = String(pkg.name);
    assert.ok(!names.has(name), `Duplicate release package ${name}`);
    names.add(name);
    const directory = installed.directories.get(name);
    assert.ok(directory, `Unselected family ${name}`);
    assert.equal(
      metadataRecord(locks[`node_modules/${name}`]).resolved,
      pkg.url,
      `${name}: unselected archive`,
    );
    const metadata = readMetadata(resolve(directory, "package.json"));
    assert.equal(metadata.version, release.version, `${name}: unselected family version`);
    assertProgramDependencies(metadata, pkg);
    artifactCount += verifyArtifacts(directory, pkg.artifacts);
  }
  return { ...installed, artifactCount };
}

function verifyArtifacts(directory: string, value: unknown): number {
  assert.ok(Array.isArray(value));
  for (const entry of value) {
    const artifact = metadataRecord(entry);
    const path = artifactPath(directory, artifact.path);
    assertBytesIdentity(readFileSync(path), artifact, path);
  }
  return value.length;
}
