import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  artifactJson,
  assertAcceptedRecordCheckout,
  assertJobBinding,
  assertLandedPullRequest,
  assertObservationSequence,
  assertMainRun,
  assertUploader,
  authority,
  fullSha,
  git,
  mainEvidence,
  oracleAt,
  requestArtifact,
  requestArtifacts,
  requestJobs,
  requestPullRequest,
  requestRun,
  requestWorkflowRuns,
  scoringInputs,
  sourceEquivalent,
} from "./shell-scoreboard-main.ts";
import type {
  ArtifactKind,
  GithubClient,
  HostJob,
  HostRun,
  PullRequest,
  RawScore,
  UploaderEvidence,
} from "./shell-scoreboard-main.ts";
import {
  accumulateFloor,
  assertMainFloor,
  assertQualification,
  qualification,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.ts";
import type { MainFloor, Qualification } from "./shell-scoreboard-floor.ts";
import {
  assertBinding,
  assertRecord,
  assertRunBinding,
  digest,
  isRecord,
} from "./shell-scoreboard.ts";
import type { Binding, Oracle, PullRequestBinding, RunBinding } from "./shell-scoreboard.ts";
import { assertHistoricalRaw } from "./shell-scoreboard-accepted-gains.ts";
import type {
  AcceptedGainFloor,
  HistoricalAcceptedRawScore,
} from "./shell-scoreboard-accepted-gains.ts";

export const terminalCut = Object.freeze({
  sourceSha: "c442e234405e00dcb25e7503cbd930185fbfd63f",
  baseSha: "b8d7d16b600968523ac6165275852c2a552014db",
  gaps: Object.freeze([
    "d9e52b8c4ba80145039e5c28e337c0300de6cf34",
    "69ed868e4d5cf1274993ed32feb717423c5582fd",
  ]),
  recordPath: "scoreboard/accepted-gains/terminal-main-2026-10-29.json",
  recordDigest: "ce9ea1108674599cc30734efc58f711f2c145e455468852f9be4078694de3dec",
});
interface ArtifactClaim {
  artifactId: number;
  archiveSha256: string;
  payloadSha256: string;
  uploader: UploaderEvidence;
}
interface Lifetime {
  expires: number;
}
export interface TerminalContributionRecord {
  landed: {
    mergeCommit: string;
    firstParent: string;
    [key: string]: unknown;
  };
  original: {
    binding: PullRequestBinding;
    run: RunBinding;
    inputsSha256: string;
    resultSha256: string;
    capturedFloorSha256: string;
    [key: string]: unknown;
  };
  gains: string[];
  gainsSha256: string;
  [key: string]: unknown;
}
export interface TerminalLandedEntry extends TerminalContributionRecord {
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
  artifacts: { raw: ArtifactClaim; qualification: ArtifactClaim };
}
export interface TerminalRequirementRecord {
  base: {
    sourceSha: string;
    run: RunBinding;
    floorSha256: string;
  };
  landed: TerminalContributionRecord[];
  requirement: { count: number; floorSha256: string };
  [key: string]: unknown;
}
export interface TerminalRecord extends TerminalRequirementRecord {
  schema: number;
  kind: "accepted-main-requirement-chain";
  base: {
    sourceSha: string;
    run: RunBinding;
    floorSha256: string;
    artifact: ArtifactClaim;
  };
  landed: TerminalLandedEntry[];
  cancelled: { sourceSha: string; runId: number; attempt: number }[];
}
export interface TerminalContribution {
  record: TerminalContributionRecord;
  raw: HistoricalAcceptedRawScore;
  receipt: Qualification;
}
interface TerminalFacts {
  parents: string[];
  tree: string;
  testedParents: string[];
  testedTree: string;
  ancestor: string;
  composedTree: string;
  inputsSha256: string;
}
function time(value: unknown): number {
  assert.ok(typeof value === "string", "missing evidence time");
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result), "missing evidence time");
  return result;
}
function unique<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const matches = items.filter(predicate);
  assert.equal(matches.length, 1, `missing/ambiguous ${label}`);
  return matches[0];
}
function complete<List extends { total_count: number }, Field extends keyof List>(
  value: List,
  field: Field,
): List[Field] {
  assert.ok(
    Number.isSafeInteger(value.total_count) && value.total_count >= 0 && value.total_count <= 100,
    "unbounded host listing",
  );
  const entries = value[field];
  assert.ok(Array.isArray(entries), "missing host listing");
  assert.equal(entries.length, value.total_count, "incomplete host listing");
  return entries;
}
function history(root: string, sourceSha: string): string[] {
  return git(root, ["rev-list", "--first-parent", "--max-count=33", fullSha(sourceSha)]).split(
    "\n",
  );
}
export function terminalRecoveryTarget(root: string, sourceSha: string): boolean {
  return history(root, sourceSha).includes(terminalCut.sourceSha);
}
export function terminalGap(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.name === "FloorPrerequisite" &&
    error.reason === "missing-non-equivalent-main-score" &&
    typeof error.sourceSha === "string" &&
    terminalCut.gaps.includes(error.sourceSha)
  );
}
function recordEntries(root: string, sourceSha: string): string[] {
  return git(root, ["ls-tree", "-r", sourceSha, "--", "scoreboard/accepted-gains"])
    .split("\n")
    .filter(Boolean);
}
function assertUploaderEvidence(value: unknown): asserts value is UploaderEvidence {
  assertRecord(value);
  for (const key of ["runId", "attempt", "jobId", "artifactId"])
    assert.equal(typeof value[key], "number", `invalid uploader ${key}`);
  for (const key of ["archiveSha256", "uploaderLogsSha256"])
    assert.equal(typeof value[key], "string", `invalid uploader ${key}`);
}
function assertArtifactClaim(value: unknown): asserts value is ArtifactClaim {
  assertRecord(value);
  assert.equal(typeof value.artifactId, "number", "invalid artifact claim");
  assert.equal(typeof value.archiveSha256, "string", "invalid artifact archive");
  assert.equal(typeof value.payloadSha256, "string", "invalid artifact payload");
  assertUploaderEvidence(value.uploader);
}
function assertLandedEntry(value: unknown): asserts value is TerminalLandedEntry {
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
  assertRecord(value.artifacts);
  assertArtifactClaim(value.artifacts.raw);
  assertArtifactClaim(value.artifacts.qualification);
  assert.ok(Array.isArray(value.gains), "missing terminal gains");
  for (const id of value.gains) assert.equal(typeof id, "string", "invalid terminal gain");
  assert.equal(typeof value.gainsSha256, "string", "invalid terminal gain digest");
}
export function assertTerminalRecord(value: unknown): asserts value is TerminalRecord {
  assertRecord(value);
  assertRecord(value.base);
  fullSha(value.base.sourceSha);
  assertRunBinding(value.base.run);
  assert.equal(typeof value.base.floorSha256, "string", "invalid terminal base digest");
  assertArtifactClaim(value.base.artifact);
  assert.ok(Array.isArray(value.landed), "missing terminal landed chain");
  for (const entry of value.landed) assertLandedEntry(entry);
  assert.ok(Array.isArray(value.cancelled), "missing cancelled chain");
  for (const claim of value.cancelled) {
    assertRecord(claim);
    fullSha(claim.sourceSha);
    assert.equal(typeof claim.runId, "number", "invalid cancelled run");
    assert.equal(typeof claim.attempt, "number", "invalid cancelled attempt");
  }
  assertRecord(value.requirement);
  assert.equal(typeof value.requirement.count, "number", "invalid requirement count");
  assert.equal(typeof value.requirement.floorSha256, "string", "invalid requirement digest");
}
export function terminalRecord(root: string, sourceSha: string, selected: Binding): TerminalRecord {
  assertAcceptedRecordCheckout(root, sourceSha);
  const entries = recordEntries(root, sourceSha);
  const added = unique(
    entries,
    (line) => line.endsWith(`\t${terminalCut.recordPath}`),
    "terminal receipt",
  );
  assert.match(added, /^100644 blob /, "receipt must be a regular blob");
  assert.deepEqual(
    entries.filter((line) => line !== added),
    recordEntries(root, terminalCut.sourceSha),
    "accepted records are append-only",
  );
  const record: unknown = JSON.parse(git(root, ["show", `${sourceSha}:${terminalCut.recordPath}`]));
  assert.equal(digest(record), terminalCut.recordDigest, "unreviewed terminal receipt");
  assertTerminalRecord(record);
  assert.equal(record.schema, 1);
  assert.equal(record.kind, "accepted-main-requirement-chain");
  assert.equal(record.base.sourceSha, terminalCut.baseSha);
  assert.deepEqual(
    record.landed.map((entry) => entry.landed.mergeCommit),
    terminalCut.gaps.concat([terminalCut.sourceSha]),
  );
  assert.deepEqual(
    record.cancelled.map((entry) => entry.sourceSha),
    terminalCut.gaps,
  );
  const target = selected.kind === "pull-request" ? selected.mainSha : selected.beforeSha;
  assert.equal(
    git(root, ["merge-base", target, sourceSha]),
    target,
    "candidate does not include captured main",
  );
  const parents = git(root, ["show", "-s", "--format=%P", sourceSha]).split(" ");
  if (selected.kind === "pull-request") {
    assert.equal(selected.testedMergeSha, sourceSha);
    assert.deepEqual(parents, [selected.baseSha, selected.headSha], "candidate merge topology");
  } else {
    assert.equal(selected.kind, "main-push");
    assert.equal(selected.sourceSha, sourceSha);
    assert.deepEqual(parents, [target], "fixed-cut recovery requires a single-commit push");
  }
  assert.ok(terminalRecoveryTarget(root, target), "target is outside terminal recovery history");
  return record;
}
export function assertTerminalCancelled(
  claim: TerminalRecord["cancelled"][number],
  run: HostRun,
  jobs: HostJob[],
  artifacts: { name: string; [key: string]: unknown }[],
): void {
  assertMainRun(run, claim.sourceSha, claim.attempt);
  assert.equal(run.id, claim.runId, "wrong cancelled run");
  assert.equal(run.status, "completed", "nonterminal cancelled run");
  assert.equal(run.conclusion, "cancelled", "different main failure");
  assert.ok(
    !artifacts.some((item) => /^own-shell-(raw|floor|current)-/.test(item.name)),
    "normal main evidence exists",
  );
  for (const job of jobs) {
    assertJobBinding(job, run);
    assert.equal(job.status, "completed");
    assert.ok(
      ["success", "skipped", "cancelled"].includes(job.conclusion ?? ""),
      "different main job failure",
    );
  }
  for (const name of ["own-shell-observation", "own-shell-compatibility", "score-floor"]) {
    const producers = jobs.filter((item) => item.name === name);
    assert.ok(producers.length <= 1, "ambiguous cancelled producer");
    if (!producers.length) continue;
    assert.ok(
      ["cancelled", "skipped"].includes(producers[0].conclusion ?? ""),
      "producer was not cancelled",
    );
    const steps = producers[0].steps;
    const observation = steps.filter(
      (item) =>
        item.name === "Observe compatibility with the shared node build" ||
        item.name === "Seal complete raw score" ||
        item.name === "Fold main floor and qualification",
    );
    assert.ok(
      observation.every((item) => item.conclusion === "skipped"),
      "cancelled producer already observed",
    );
  }
}
export function assertTerminalJobs(
  run: HostRun,
  jobs: HostJob[],
  workflow: string,
  mergedAt: string,
): void {
  const definition: unknown = parse(workflow);
  assertRecord(definition);
  assertRecord(definition.jobs);
  const names = Object.keys(definition.jobs).sort();
  assert.equal(names.length, 12, "reviewed terminal Shell job set");
  assert.deepEqual(jobs.map((job) => job.name).sort(), names, "missing/extra original job");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  for (const job of jobs) {
    assertJobBinding(job, run);
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
    assert.ok(
      time(job.started_at) <= time(job.completed_at) && time(job.completed_at) < time(mergedAt),
      "original job finished after merge",
    );
  }
}
export function assertTerminalLanded(
  record: TerminalLandedEntry,
  pr: PullRequest,
  facts: TerminalFacts,
): void {
  const { landed, original } = record;
  assertLandedPullRequest(pr, record);
  assert.equal(original.binding.kind, "pull-request");
  assert.deepEqual(facts.parents, [landed.firstParent], "landed first parent changed");
  assert.equal(facts.tree, landed.tree, "landed tree changed");
  assert.deepEqual(
    facts.testedParents,
    [original.binding.baseSha, original.binding.headSha],
    "original merge topology",
  );
  assert.equal(facts.testedTree, original.tree, "original tested tree changed");
  assert.equal(facts.ancestor, original.binding.baseSha, "original base not in landed history");
  assert.equal(facts.composedTree, landed.tree, "different landed composition");
  assert.equal(facts.inputsSha256, original.inputsSha256, "original source inputs changed");
}
async function runJobs(
  client: GithubClient,
  binding: RunBinding,
): Promise<{ run: HostRun; jobs: HostJob[] }> {
  const run = await requestRun(
    client,
    `/actions/runs/${binding.runId}/attempts/${binding.attempt}`,
  );
  assert.equal(run.id, binding.runId);
  assert.equal(run.run_attempt, binding.attempt);
  const listing = await requestJobs(
    client,
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  const jobs = complete(listing, "jobs");
  return { run, jobs };
}
async function artifact(
  root: string,
  client: GithubClient,
  host: { run: HostRun; jobs: HostJob[] },
  claim: ArtifactClaim,
  sourceSha: string,
  kind: ArtifactKind,
  lifetime: Lifetime,
): Promise<unknown> {
  const metadata = await requestArtifact(client, `/actions/artifacts/${claim.artifactId}`);
  assert.equal(metadata.id, claim.artifactId);
  assert.equal(metadata.digest, `sha256:${claim.archiveSha256}`);
  lifetime.expires = Math.min(lifetime.expires, time(metadata.expires_at));
  assert.ok(lifetime.expires > Date.now(), "expired recovery evidence");
  const job = unique(host.jobs, (item) => item.id === claim.uploader.jobId, "recorded uploader");
  const evidence = assertUploader({
    ...host,
    job,
    artifact: metadata,
    kind,
    workflow: git(root, ["show", `${sourceSha}:${authority.workflowPath}`]),
    logs: await client.request(`/actions/jobs/${job.id}/logs`, "text"),
    testedSource: sourceSha,
  });
  assert.deepEqual(evidence, claim.uploader, "uploader chain changed");
  const value = artifactJson(
    await client.request(`/actions/artifacts/${claim.artifactId}/zip`, "bytes"),
    metadata,
    kind === "qualification" ? "qualification.json" : `${kind}.json`,
  );
  assert.equal(digest(value), claim.payloadSha256, "recorded payload changed");
  return value;
}
async function acceptedContribution(
  root: string,
  client: GithubClient,
  oracle: Oracle,
  record: TerminalLandedEntry,
  lifetime: Lifetime,
): Promise<TerminalContribution> {
  const { landed, original } = record;
  const pr = await requestPullRequest(client, `/pulls/${landed.pr}`);
  const tested = fullSha(original.binding.testedMergeSha);
  git(root, ["fetch", "--no-tags", "origin", tested]);
  assertTerminalLanded(record, pr, {
    parents: git(root, ["show", "-s", "--format=%P", landed.mergeCommit]).split(" "),
    tree: git(root, ["rev-parse", `${landed.mergeCommit}^{tree}`]),
    testedParents: git(root, ["show", "-s", "--format=%P", tested]).split(" "),
    testedTree: git(root, ["rev-parse", `${tested}^{tree}`]),
    ancestor: git(root, ["merge-base", original.binding.baseSha, landed.firstParent]),
    composedTree: git(root, [
      "merge-tree",
      "--write-tree",
      landed.firstParent,
      original.binding.headSha,
    ]),
    inputsSha256: digest(scoringInputs(root, tested)),
  });
  assert.deepEqual(
    oracleAt(root, tested).identity,
    oracle.identity,
    "original frozen oracle changed",
  );
  const listing = await requestWorkflowRuns(
    client,
    `/actions/workflows/${authority.workflowId}/runs?event=pull_request&head_sha=${original.binding.headSha}&per_page=100`,
  );
  const runs = complete(listing, "workflow_runs");
  assert.equal(runs.length, 1, "unreviewed original PR run set");
  assert.equal(runs[0].id, original.run.runId);
  assert.equal(runs[0].run_attempt, original.run.attempt, "original PR gained another attempt");
  const host = await runJobs(client, original.run);
  assert.equal(host.run.repository?.id, authority.repositoryId);
  assert.equal(host.run.head_repository?.id, authority.repositoryId);
  assert.equal(host.run.workflow_id, authority.workflowId);
  assert.equal(host.run.path, authority.workflowPath);
  assert.equal(host.run.event, "pull_request");
  assert.equal(host.run.head_sha, original.binding.headSha);
  assertTerminalJobs(
    host.run,
    host.jobs,
    git(root, ["show", `${tested}:${authority.workflowPath}`]),
    pr.merged_at,
  );
  const raw = await artifact(root, client, host, record.artifacts.raw, tested, "raw", lifetime);
  assertHistoricalRaw(raw);
  const receipt = await artifact(
    root,
    client,
    host,
    record.artifacts.qualification,
    tested,
    "qualification",
    lifetime,
  );
  assertQualification(receipt);
  return { record, raw, receipt };
}
export function recomputeTerminalRequirement(
  oracle: Oracle,
  record: TerminalRequirementRecord,
  base: MainFloor,
  contributions: TerminalContribution[],
): MainFloor {
  validateFloor(oracle, base);
  assert.equal(base.sourceSha, record.base.sourceSha);
  assert.deepEqual(base.run, record.base.run);
  assert.equal(base.floorSha256, record.base.floorSha256);
  assert.deepEqual(base.lostIds, [], "base floor losses");
  assert.equal(contributions.length, record.landed.length, "incomplete receipt chain");
  let previous = base.sourceSha;
  let required = base;
  for (const [index, contribution] of contributions.entries()) {
    assert.deepEqual(contribution.record, record.landed[index], "foreign accepted contribution");
    const { raw, receipt, record: entry } = contribution;
    assert.equal(entry.landed.firstParent, previous, "broken landed chain");
    previous = entry.landed.mergeCommit;
    assert.equal(raw.schema, 1);
    assert.equal(raw.kind, "raw-score");
    assert.equal(raw.sourceSha, entry.original.binding.testedMergeSha);
    assert.deepEqual(raw.selected, entry.original.binding);
    assert.deepEqual(raw.run, entry.original.run);
    assert.equal(raw.inputsSha256, entry.original.inputsSha256);
    assert.equal(raw.resultSha256, digest(raw.score));
    assert.equal(raw.resultSha256, entry.original.resultSha256);
    validateOwnScore(oracle, raw.score);
    validateFloor(oracle, raw.floor);
    assert.equal(raw.floor.sourceSha, raw.selected.mainSha);
    assert.equal(raw.floor.floorSha256, entry.original.capturedFloorSha256);
    const expected = qualification(oracle, raw.floor, raw.score, raw.selected);
    const { observedMainAfter: _observed, ...actual } = receipt;
    assert.deepEqual(actual, expected, "original qualification differs from recomputation");
    assert.equal(expected.ok, true, "original accepted losses");
    const gains = Object.values(expected.corpora)
      .flatMap((row) => row.gained)
      .sort();
    assert.deepEqual(gains, entry.gains, "recorded gains changed");
    assert.equal(digest(gains), entry.gainsSha256);
    required = accumulateFloor({
      oracle,
      sourceSha: base.sourceSha,
      predecessors: [required, raw.floor],
      scores: [raw.score],
    });
  }
  assert.equal(required.floorIds.length, record.requirement.count, "accepted count changed");
  assert.equal(required.floorSha256, record.requirement.floorSha256, "accepted membership changed");
  return required;
}
async function cancelledRuns(
  root: string,
  client: GithubClient,
  oracle: Oracle,
  record: TerminalRecord,
): Promise<void> {
  const evidence = mainEvidence({ root, oracle, client });
  for (const claim of record.cancelled) {
    const listing = await requestWorkflowRuns(
      client,
      `/actions/workflows/${authority.workflowId}/runs?event=push&head_sha=${claim.sourceSha}&per_page=100`,
    );
    const runs = complete(listing, "workflow_runs");
    assert.equal(runs.length, 1, "different cancelled main run set");
    assert.equal(runs[0].id, claim.runId);
    assert.equal(runs[0].run_attempt, claim.attempt, "cancelled main retried");
    const host = await runJobs(client, claim);
    const artifactListing = await requestArtifacts(
      client,
      `/actions/runs/${claim.runId}/artifacts?per_page=100`,
    );
    const artifacts = complete(artifactListing, "artifacts");
    assertTerminalCancelled(claim, host.run, host.jobs, artifacts);
    assert.deepEqual(
      await evidence.collect(claim.sourceSha),
      { floors: [], scores: [], evidence: [] },
      "gap gained normal evidence",
    );
  }
}
export async function prepareTerminalRecovery({
  root,
  client,
  oracle,
  sourceSha,
  selected,
  lifetime,
}: {
  root: string;
  client: GithubClient;
  oracle: Oracle;
  sourceSha: string;
  selected: Binding;
  lifetime: Lifetime;
}): Promise<AcceptedGainFloor> {
  const record = terminalRecord(root, sourceSha, selected);
  await cancelledRuns(root, client, oracle, record);
  const baseHost = await runJobs(client, record.base.run);
  assertMainRun(baseHost.run, record.base.sourceSha, record.base.run.attempt);
  assertTerminalJobs(
    baseHost.run,
    baseHost.jobs,
    git(root, ["show", `${record.base.sourceSha}:${authority.workflowPath}`]),
    new Date().toISOString(),
  );
  const base = await artifact(
    root,
    client,
    baseHost,
    record.base.artifact,
    record.base.sourceSha,
    "floor",
    lifetime,
  );
  assertMainFloor(base);
  const contributions: TerminalContribution[] = [];
  for (const entry of record.landed)
    contributions.push(await acceptedContribution(root, client, oracle, entry, lifetime));
  let required = recomputeTerminalRequirement(oracle, record, base, contributions);
  const target = selected.kind === "pull-request" ? selected.mainSha : selected.beforeSha;
  const collector = mainEvidence({ root, oracle, client });
  const observedBase = await collector.collect(record.base.sourceSha);
  required = accumulateFloor({
    oracle,
    sourceSha: base.sourceSha,
    predecessors: [required].concat(observedBase.floors),
    scores: observedBase.scores,
    evidence: required.evidence.concat(observedBase.evidence),
  });
  const lineage = history(root, target);
  const included = lineage.slice(0, lineage.indexOf(terminalCut.sourceSha) + 1).reverse();
  for (const current of included) {
    const found = await collector.collect(current);
    const before = git(root, ["rev-parse", `${current}^1`]);
    assert.ok(
      current === terminalCut.sourceSha ||
        found.scores.length ||
        sourceEquivalent(root, before, current),
      "uncovered main edge after fixed cut",
    );
    required = accumulateFloor({
      oracle,
      sourceSha: base.sourceSha,
      predecessors: [required].concat(found.floors),
      scores: found.scores,
      evidence: required.evidence.concat(found.evidence),
    });
  }
  return {
    kind: "AcceptedGainFloor",
    recovery: "terminal-2026-10-29",
    base,
    landedMerge: terminalCut.sourceSha,
    acceptedRecordDigest: digest(record),
    gained: required.floorIds.filter((id) => !base.floorIds.includes(id)),
    ids: required.floorIds,
    floorSha256: required.floorSha256,
    evidence: required.evidence,
  };
}
function successfulStep(job: Pick<HostJob, "steps">, label: string): HostJob["steps"][number] {
  const step = unique(job.steps, (item) => item.name === label, label);
  assert.equal(step.status, "completed");
  assert.equal(step.conclusion, "success");
  assert.ok(time(step.completed_at) >= time(step.started_at));
  return step;
}
export function assertTerminalFreshObservation(
  raw: Pick<RawScore<unknown>, "sourceSha" | "run" | "selected" | "capturedAt">,
  jobs: Pick<
    HostJob,
    "name" | "run_id" | "run_attempt" | "head_sha" | "status" | "conclusion" | "steps"
  >[],
): void {
  const observer = unique(jobs, (job) => job.name === "own-shell-observation", "Waffle observer");
  const sealer = unique(jobs, (job) => job.name === "own-shell-compatibility", "raw sealer");
  for (const job of [observer, sealer]) {
    assertJobBinding(job, {
      id: raw.run.runId,
      run_attempt: raw.run.attempt,
      head_sha: raw.selected.kind === "pull-request" ? raw.selected.headSha : raw.sourceSha,
    });
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
  }
  const bound = successfulStep(observer, "Bind qualification and resolve PR main floor");
  const observed = successfulStep(observer, "Observe compatibility with the shared node build");
  const sealed = successfulStep(sealer, "Seal complete raw score");
  assert.ok(bound.number < observed.number, "observer order changed");
  assert.ok(
    time(raw.capturedAt) >= time(bound.started_at) &&
      time(raw.capturedAt) < time(bound.completed_at) + 1000,
    "preparation outside bound step",
  );
  assertObservationSequence(raw, bound, observed, sealed);
}
