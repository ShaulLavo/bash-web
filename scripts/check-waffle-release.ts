import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMetadata } from "./installed-waffle.ts";
import {
  assertPackageHostInterface,
  metadataRecord,
  parseHostInterface,
} from "./waffle-host-interface.ts";

export function assertProgramRuntimeIdentity(value: unknown, expected: unknown): void {
  const runtime = metadataRecord(value);
  const identity = metadataRecord(expected);
  assert.ok(
    typeof identity.url === "string" && identity.url.length > 0,
    "Missing program runtime URL pin",
  );
  assert.ok(
    typeof identity.bytes === "number" &&
      Number.isSafeInteger(identity.bytes) &&
      identity.bytes > 0,
    "Invalid program runtime byte length pin",
  );
  assert.ok(typeof identity.sha256 === "string", "Missing program runtime SHA-256 pin");
  assert.match(identity.sha256, /^[a-f0-9]{64}$/, "Invalid program runtime SHA-256 pin");
  assert.equal(runtime.url, identity.url, "program release runtime URL mismatch");
  assert.equal(runtime.bytes, identity.bytes, "program release runtime byte length mismatch");
  assert.equal(runtime.sha256, identity.sha256, "program release runtime SHA-256 mismatch");
}

export function checkReleaseMetadata(
  value: unknown,
  selected: unknown,
  kind: string,
  version: string,
): void {
  const required = parseHostInterface(metadataRecord(selected).hostInterface, "selected Waffle");
  const release = metadataRecord(value);
  assert.equal(release.version, version, "Release version mismatch");
  if (kind === "runtime") {
    assert.equal(release.name, "waffle");
    assertPackageHostInterface(release, required, "candidate runtime");
    return;
  }
  assert.equal(kind, "programs");
  assert.equal(release.schema, "waffle-program-release/2");
  assert.equal(release.tagState, "tagged");
  assert.equal(release.dirty, false);
  assert.match(String(release.sourceCommit), /^[a-f0-9]{40}$/);
  assertPackageHostInterface(release.runtime, required, "candidate family runtime");
  const runtime = metadataRecord(selected);
  assertProgramRuntimeIdentity(release.runtime, {
    url: runtime.specifier,
    bytes: runtime.archiveBytes,
    sha256: runtime.archiveSha256,
  });
  assert.ok(Array.isArray(release.packages) && release.packages.length > 0);
  for (const pkg of release.packages) assertPackageHostInterface(pkg, required, "candidate family");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, path, version] = process.argv.slice(2);
  assert.ok(path && version);
  const bytes =
    kind === "runtime"
      ? execFileSync("tar", ["-xOf", path, "package/package.json"])
      : readFileSync(path);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  checkReleaseMetadata(value, readMetadata(resolve("sources.lock.json")).waffle, kind, version);
}
