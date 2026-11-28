import assert from "node:assert/strict";
import { parse } from "yaml";
import { assertJobBinding, fullSha, requestArtifact } from "./shell-scoreboard-main.ts";
import type {
  GithubClient,
  HostArtifact,
  HostJob,
  HostRun,
  RawScore,
  UploaderEvidence,
} from "./shell-scoreboard-main.ts";
import { assertMainFloor } from "./shell-scoreboard-floor.ts";
import type { FloorEvidence, MainFloor } from "./shell-scoreboard-floor.ts";
import { assertBinding, assertRecord, assertRunBinding, assertScore } from "./shell-scoreboard.ts";
import type { PullRequestBinding, RunBinding } from "./shell-scoreboard.ts";

export interface AcceptedGainFloor {
  kind: "AcceptedGainFloor";
  recovery?: "terminal-2026-10-29";
  base: MainFloor;
  landedMerge: string;
  acceptedRecordDigest: string;
  gained: string[];
  ids: string[];
  floorSha256: string;
  evidence?: FloorEvidence[];
}
export type AcceptedRawScore = RawScore<AcceptedGainFloor> & {
  floor: AcceptedGainFloor;
  capturedAt: string;
};
export type HistoricalAcceptedRawScore = RawScore<MainFloor> & {
  selected: PullRequestBinding;
  floor: MainFloor;
  capturedAt: string;
};
export interface Lifetime {
  expires: number;
}
export interface ArtifactClaim {
  artifactId: number;
  archiveSha256: string;
  payloadSha256: string;
  uploader: UploaderEvidence;
}
export interface LandedContribution {
  landed: {
    pr: number;
    mergeCommit: string;
    firstParent: string;
    tree: string;
    [key: string]: unknown;
  };
  original: {
    binding: PullRequestBinding;
    run: RunBinding;
    tree: string;
    inputsSha256: string;
    resultSha256: string;
    capturedFloorSha256: string;
    [key: string]: unknown;
  };
  gains: string[];
  gainsSha256: string;
  [key: string]: unknown;
}
export function time(value: unknown): number {
  assert.ok(typeof value === "string", "missing evidence time");
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result), "missing evidence time");
  return result;
}
export function unique<T>(items: T[], predicate: (item: T) => boolean, name: string): T {
  const found = items.filter(predicate);
  assert.equal(found.length, 1, `missing/ambiguous ${name}`);
  return found[0];
}
function assertUploaderEvidence(value: unknown): asserts value is UploaderEvidence {
  assertRecord(value);
  for (const key of ["runId", "attempt", "jobId", "artifactId"])
    assert.equal(typeof value[key], "number", `invalid uploader ${key}`);
  for (const key of ["archiveSha256", "uploaderLogsSha256"])
    assert.equal(typeof value[key], "string", `invalid uploader ${key}`);
}
export function assertArtifactClaim(value: unknown): asserts value is ArtifactClaim {
  assertRecord(value);
  assert.equal(typeof value.artifactId, "number", "invalid artifact claim");
  assert.equal(typeof value.archiveSha256, "string", "invalid artifact archive");
  assert.equal(typeof value.payloadSha256, "string", "invalid artifact payload");
  assertUploaderEvidence(value.uploader);
}
export function assertLandedContribution(value: unknown): asserts value is LandedContribution {
  assertRecord(value);
  assertRecord(value.landed);
  assert.equal(typeof value.landed.pr, "number", "invalid landed PR");
  for (const key of ["mergeCommit", "firstParent", "tree"])
    assert.equal(typeof value.landed[key], "string", `invalid landed ${key}`);
  assertRecord(value.original);
  assertBinding(value.original.binding);
  assert.equal(value.original.binding.kind, "pull-request");
  assertRunBinding(value.original.run);
  for (const key of ["tree", "inputsSha256", "resultSha256", "capturedFloorSha256"])
    assert.equal(typeof value.original[key], "string", `invalid original ${key}`);
  assert.ok(Array.isArray(value.gains), "invalid accepted gains");
  for (const id of value.gains) assert.equal(typeof id, "string", "invalid accepted gain");
  assert.equal(typeof value.gainsSha256, "string", "invalid accepted gain digest");
}
export function assertAcceptedFloor(value: unknown): asserts value is AcceptedGainFloor {
  assertRecord(value);
  assert.equal(value.kind, "AcceptedGainFloor", "unsupported accepted floor");
  assertMainFloor(value.base);
  assert.equal(typeof value.landedMerge, "string", "missing landed merge");
  assert.equal(typeof value.acceptedRecordDigest, "string", "missing accepted record digest");
  assert.ok(Array.isArray(value.gained), "missing accepted gains");
  assert.ok(Array.isArray(value.ids), "missing accepted IDs");
  for (const id of value.gained.concat(value.ids))
    assert.equal(typeof id, "string", "invalid accepted ID");
  assert.equal(typeof value.floorSha256, "string", "missing accepted floor digest");
}
export function assertRawIdentity(value: unknown): asserts value is RawScore<unknown> {
  assertRecord(value);
  assertBinding(value.selected);
  assertRunBinding(value.run);
  fullSha(value.sourceSha);
  assert.equal(typeof value.capturedAt, "string", "missing raw capture time");
  assert.equal(typeof value.inputsSha256, "string", "missing raw input digest");
  assert.equal(typeof value.resultSha256, "string", "missing raw result digest");
  assertScore(value.score);
}
export function assertAcceptedRaw(value: unknown): asserts value is AcceptedRawScore {
  assertRawIdentity(value);
  assertAcceptedFloor(value.floor);
}
export function assertHistoricalRaw(value: unknown): asserts value is HistoricalAcceptedRawScore {
  assertRawIdentity(value);
  assert.ok(
    value.selected.kind === "pull-request",
    "historical accepted evidence requires a pull request",
  );
  assertMainFloor(value.floor);
}

export function assertHistoricalJobSet(
  run: HostRun,
  jobs: HostJob[],
  workflow: string,
  mergedAt: string,
  expectedCount: number,
  description: string,
): void {
  const definition: unknown = parse(workflow);
  assertRecord(definition);
  assertRecord(definition.jobs);
  const names = Object.keys(definition.jobs).sort();
  assert.equal(names.length, expectedCount, description);
  assert.deepEqual(jobs.map((item) => item.name).sort(), names, "missing/extra historical job");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  for (const job of jobs) {
    assertJobBinding(job, run);
    assert.equal(job.status, "completed", "unfinished historical job");
    assert.equal(job.conclusion, "success", "failed historical job");
    assert.ok(
      time(job.started_at) <= time(job.completed_at) && time(job.completed_at) < time(mergedAt),
      "historical job did not finish before merge",
    );
  }
}
export async function claimedArtifactMetadata(
  client: GithubClient,
  claim: ArtifactClaim,
): Promise<HostArtifact> {
  const metadata = await requestArtifact(client, `/actions/artifacts/${claim.artifactId}`);
  assert.equal(metadata.id, claim.artifactId);
  assert.equal(metadata.digest, `sha256:${claim.archiveSha256}`);
  return metadata;
}
