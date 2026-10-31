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
