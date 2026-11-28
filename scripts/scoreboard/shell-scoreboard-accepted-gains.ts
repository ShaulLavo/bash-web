import {
  assertArtifactClaim,
  assertHistoricalJobSet,
  assertHistoricalRaw,
  assertLandedContribution,
  claimedArtifactMetadata,
  time,
  unique,
} from "./shell-scoreboard-accepted-evidence.ts";
import type {
  AcceptedGainFloor,
  AcceptedRawScore,
  ArtifactClaim,
  HistoricalAcceptedRawScore,
  LandedContribution,
  Lifetime,
} from "./shell-scoreboard-accepted-evidence.ts";
import assert from "node:assert/strict";
import {
  admitObservation,
  admitQualificationRaw,
  assertAcceptedRecordCheckout,
  assertJobBinding,
  assertLandedPullRequest,
  assertObservationSequence,
  artifactJson,
  assertMainRun,
  assertUploader,
  authority,
  fullSha,
  git,
  hasStepTimes,
  oracleAt,
  requestArtifact,
  requestArtifacts,
  requestJobs,
  requestPullRequest,
  requestRun,
  requestWorkflowRuns,
  scoringInputs,
} from "./shell-scoreboard-main.ts";
import type {
  ArtifactKind,
  CompletedHostStep,
  GithubClient,
  HostJob,
  HostRun,
  PullRequest,
} from "./shell-scoreboard-main.ts";
import {
  assertMainFloor,
  assertQualification,
  bootstrap,
  qualification,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.ts";
import type { MainFloor, Qualification } from "./shell-scoreboard-floor.ts";
import { assertRecord, assertRunBinding, digest } from "./shell-scoreboard.ts";
import type { Binding, Oracle, PullRequestBinding, RunBinding } from "./shell-scoreboard.ts";
import {
  terminalGap,
  prepareTerminalRecovery,
  assertTerminalFreshObservation,
} from "./shell-scoreboard-terminal-recovery.ts";
import { mainEvidence, resolveMainFloor } from "./shell-scoreboard-main-evidence.ts";

const merge = "f6e3a9e67d56332b0476f3608e198bf74e8e12f3";
const recordPath = `scoreboard/accepted-gains/${merge}.json`;
const approvedRecord = "b52a1382c647009f0587c73ddd0f75158f14665bd02e8ac1cea4920da5454dff";
const blockedRun = 40157800143;
const nativeTest =
  "interpreter::command_builtin::tests::timed_function_declaration_output_releases_storage_on_cancel_and_drop";
interface MainObservedFloor {
  kind: "MainObservedFloor";
  floor: MainFloor;
  recovery?: undefined;
}
type PreparedFloor = MainObservedFloor | AcceptedGainFloor;
export interface PreparedCandidate {
  floor: PreparedFloor;
  sourceSha: string;
  selected: Binding;
  run: RunBinding;
}
interface PreparationContext {
  root: string;
  client: GithubClient;
  oracle: Oracle;
  lifetime: Lifetime;
}
export interface AcceptedGainRecord {
  landed: {
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
  rowIdentitySha256: string;
  skipMembershipSha256: string;
  gains: string[];
  gainsSha256: string;
  baseFloor: { sourceSha: string; run: RunBinding; floorSha256: string };
  [key: string]: unknown;
}
export type AcceptedRecord = AcceptedGainRecord &
  LandedContribution & {
    artifacts: { raw: ArtifactClaim; qualification: ArtifactClaim; baseFloor: ArtifactClaim };
  };
interface TreeEntry {
  path: string;
  mode: string;
  blob: string;
}
interface GitFacts {
  parents: string[];
  tree: string;
  originalParents: string[];
  originalTree: string;
  ancestor: string;
  composedTree: string;
  inputsSha256: string;
}
const preparations = new WeakMap<PreparedCandidate, PreparationContext>();
const observations = new WeakMap<object, AcceptedRawScore>();

function immutable<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}
function step(job: Pick<HostJob, "steps">, name: string): CompletedHostStep {
  const value = unique(job.steps, (item) => item.name === name, name);
  assert.equal(value.status, "completed", `unfinished ${name}`);
  assert.equal(value.conclusion, "success", `failed ${name}`);
  assert.ok(hasStepTimes(value), "missing evidence time");
  assert.ok(time(value.completed_at) >= time(value.started_at), "invalid step interval");
  return value;
}
function complete<List extends { total_count: number }, Field extends keyof List>(
  list: List,
  field: Field,
): List[Field] {
  assert.ok(
    Number.isSafeInteger(list.total_count) && list.total_count <= 100,
    "unbounded host listing",
  );
  const values = list[field];
  assert.ok(Array.isArray(values), "missing host listing");
  assert.equal(values.length, list.total_count, "incomplete host listing");
  return values;
}
export function assertAcceptedRecord(value: unknown): asserts value is AcceptedRecord {
  assertLandedContribution(value);
  assertRecord(value.artifacts);
  assertArtifactClaim(value.artifacts.raw);
  assertArtifactClaim(value.artifacts.qualification);
  assertArtifactClaim(value.artifacts.baseFloor);
  for (const key of ["rowIdentitySha256", "skipMembershipSha256"])
    assert.equal(typeof value[key], "string", `invalid record ${key}`);
  assertRecord(value.baseFloor);
  fullSha(value.baseFloor.sourceSha);
  assertRunBinding(value.baseFloor.run);
  assert.equal(typeof value.baseFloor.floorSha256, "string", "invalid base floor digest");
}
// Git blob IDs compare exact bytes, including trailing whitespace. No workspace snapshot is authority.
export function assertRecordAppend(before: TreeEntry[], after: TreeEntry[], path: string): void {
  assert.deepEqual(
    after.filter((entry) => entry.path !== path),
    before,
    "accepted records are append-only",
  );
  assert.equal(
    before.some((entry) => entry.path === path),
    false,
    "duplicate landed merge",
  );
  const added = unique(after, (entry) => entry.path === path, "new landed record");
  assert.equal(added.mode, "100644", "record must be a regular blob");
}
function records(root: string, ref: string): TreeEntry[] {
  return git(root, ["ls-tree", "-r", fullSha(ref), "--", "scoreboard/accepted-gains"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [entry, path] = line.split("\t");
      const [mode, type, blob] = entry.split(" ");
      assert.equal(type, "blob", "invalid accepted record");
      return { path, mode, blob };
    });
}
function candidateRecord(root: string, selected: Binding, sourceSha: string): AcceptedRecord {
  assertAcceptedRecordCheckout(root, sourceSha);
  assertRecordAppend(records(root, merge), records(root, sourceSha), recordPath);
  if (selected.kind === "pull-request") {
    assert.equal(selected.testedMergeSha, sourceSha);
    assert.deepEqual(
      git(root, ["show", "-s", "--format=%P", sourceSha]).split(" "),
      [selected.baseSha, selected.headSha],
      "candidate H/C/B topology",
    );
    assert.equal(
      git(root, ["merge-base", merge, sourceSha]),
      merge,
      "candidate does not include M",
    );
  } else if (selected.kind === "workflow-dispatch") {
    assert.equal(selected.sourceSha, sourceSha);
    assert.equal(
      git(root, ["merge-base", merge, sourceSha]),
      merge,
      "dispatch candidate does not include accepted merge",
    );
  } else {
    assert.equal(selected.kind, "main-push");
    assert.equal(selected.sourceSha, sourceSha);
    assert.equal(
      git(root, ["rev-parse", `${sourceSha}^1`]),
      merge,
      "recovery covers exactly one predecessor",
    );
  }
  const record: unknown = JSON.parse(git(root, ["show", `${sourceSha}:${recordPath}`]));
  assert.equal(digest(record), approvedRecord, "unreviewed accepted-gain claim");
  assertAcceptedRecord(record);
  return record;
}

export function assertTerminalBlock(
  run: HostRun,
  jobs: HostJob[],
  artifacts: { name: string; [key: string]: unknown }[],
  logs: string,
): void {
  assertMainRun(run, merge, 1);
  assert.equal(run.id, blockedRun, "wrong blocked run");
  assert.equal(run.status, "completed", "main is not terminal");
  assert.equal(run.conclusion, "failure", "main did not fail");
  assert.equal(
    artifacts.some((item) => /^own-shell-(raw|floor)-/.test(item.name)),
    false,
    "normal main artifact is present, not absent",
  );
  for (const name of ["own-shell-compatibility", "score-floor"]) {
    const job = unique(jobs, (item) => item.name === name, name);
    assert.equal(job.status, "completed", "nonterminal producer");
    assert.equal(job.conclusion, "skipped", "producer was not skipped");
    assertJobBinding(job, run);
  }
  const native = unique(jobs, (item) => item.name === "native", "native");
  assertJobBinding(native, run);
  assert.equal(native.status, "completed");
  assert.equal(native.conclusion, "failure");
  const failed = native.steps.filter((item) => item.conclusion === "failure");
  assert.deepEqual(
    failed.map((item) => item.name),
    ["Rust quality and native tests"],
    "different native failure",
  );
  const text = logs
    .split("\n")
    .map((line) => line.replace(/^\S+Z /, ""))
    .join("\n");
  assert.match(
    text,
    new RegExp(
      `---- ${nativeTest} stdout ----\\n\\nthread '[^']+' \\(\\d+\\) panicked at engine/src/interpreter/command_builtin/tests.rs:644:9:\\nassertion .left == right. failed\\n  left: 151\\n right: 103`,
    ),
    "not the reviewed 151 vs 103 failure",
  );
  assert.equal((text.match(/test result: FAILED\./g) ?? []).length, 1, "additional native failure");
  assert.match(text, /test result: FAILED\. 442 passed; 1 failed; 0 ignored;/);
}
export function assertHistoricalJobs(
  run: HostRun,
  jobs: HostJob[],
  workflow: string,
  mergedAt: string,
): void {
  assertHistoricalJobSet(run, jobs, workflow, mergedAt, 10, "reviewed historical Shell job set");
}
function assertRun(run: HostRun, record: AcceptedRecord): void {
  const { original } = record;
  assert.equal(run.id, original.run.runId);
  assert.equal(run.run_attempt, original.run.attempt);
  assert.equal(run.repository?.id, authority.repositoryId);
  assert.equal(run.head_repository?.id, authority.repositoryId);
  assert.equal(run.workflow_id, authority.workflowId);
  assert.equal(run.path, authority.workflowPath);
  assert.equal(run.event, "pull_request");
  assert.equal(run.head_sha, original.binding.headSha);
}
export function assertLandedIdentity(
  record: AcceptedRecord,
  pr: PullRequest,
  facts: GitFacts,
): void {
  const { landed, original } = record;
  assertLandedPullRequest(pr, record);
  assert.equal(pr.merge_commit_sha, merge);
  assert.equal(landed.mergeCommit, merge);
  assert.deepEqual(facts.parents, [landed.firstParent], "wrong landed parent");
  assert.equal(facts.tree, landed.tree, "wrong landed tree");
  assert.equal(original.binding.baseSha, original.binding.mainSha);
  assert.deepEqual(
    facts.originalParents,
    [original.binding.baseSha, original.binding.headSha],
    "original topology",
  );
  assert.equal(facts.originalTree, original.tree, "original C tree");
  assert.equal(facts.ancestor, original.binding.baseSha, "original base is not an ancestor");
  assert.equal(facts.composedTree, landed.tree, "unclean/different landed composition");
  assert.equal(facts.inputsSha256, original.inputsSha256);
}
function assertGit(root: string, record: AcceptedRecord, pr: PullRequest): void {
  const { landed, original } = record;
  const { baseSha, headSha, testedMergeSha } = original.binding;
  git(root, ["fetch", "--no-tags", "origin", fullSha(testedMergeSha)]);
  assertLandedIdentity(record, pr, {
    parents: git(root, ["show", "-s", "--format=%P", merge]).split(" "),
    tree: git(root, ["rev-parse", `${merge}^{tree}`]),
    originalParents: git(root, ["show", "-s", "--format=%P", testedMergeSha]).split(" "),
    originalTree: git(root, ["rev-parse", `${testedMergeSha}^{tree}`]),
    ancestor: git(root, ["merge-base", baseSha, landed.firstParent]),
    composedTree: git(root, ["merge-tree", "--write-tree", landed.firstParent, headSha]),
    inputsSha256: digest(scoringInputs(root, testedMergeSha)),
  });
}
async function jobsFor(client: GithubClient, run: HostRun): Promise<HostJob[]> {
  const listing = await requestJobs(
    client,
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  return complete(listing, "jobs");
}
async function terminalBlock(client: GithubClient): Promise<void> {
  const listing = await requestWorkflowRuns(
    client,
    `/actions/workflows/${authority.workflowId}/runs?event=push&head_sha=${merge}&per_page=100`,
  );
  const runs = complete(listing, "workflow_runs");
  assert.equal(runs.length, 1, "ambiguous blocked main run");
  assert.equal(runs[0].id, blockedRun);
  assert.equal(runs[0].run_attempt, 1, "native retries are not recovery evidence");
  const run = await requestRun(client, `/actions/runs/${blockedRun}/attempts/1`);
  const jobs = await jobsFor(client, run);
  const artifactListing = await requestArtifacts(
    client,
    `/actions/runs/${blockedRun}/artifacts?per_page=100`,
  );
  const artifacts = complete(artifactListing, "artifacts");
  const native = unique(jobs, (job) => job.name === "native", "native");
  const logs = await client.request(`/actions/jobs/${native.id}/logs`, "text");
  assertTerminalBlock(run, jobs, artifacts, logs);
}
async function artifact(
  client: GithubClient,
  run: HostRun,
  jobs: HostJob[],
  workflow: string,
  claim: ArtifactClaim,
  kind: ArtifactKind,
  testedSource: string,
  lifetime: Lifetime,
): Promise<unknown> {
  const metadata = await claimedArtifactMetadata(client, claim);
  assert.ok(metadata.expires_at, "missing artifact expiry");
  const expires = time(metadata.expires_at);
  assert.ok(expires > Date.now(), "artifact expired by timestamp");
  lifetime.expires = Math.min(lifetime.expires, expires);
  const job = unique(jobs, (item) => item.id === claim.uploader.jobId, "artifact uploader");
  const logs = await client.request(`/actions/jobs/${job.id}/logs`, "text");
  const evidence = assertUploader({
    run,
    job,
    artifact: metadata,
    kind,
    workflow,
    logs,
    testedSource,
  });
  assert.deepEqual(evidence, claim.uploader, "original uploader chain changed");
  const bytes = await client.request(`/actions/artifacts/${metadata.id}/zip`, "bytes");
  const value = artifactJson(
    bytes,
    metadata,
    kind === "qualification" ? "qualification.json" : `${kind}.json`,
  );
  assert.equal(digest(value), claim.payloadSha256, "artifact payload digest");
  return value;
}

export function recomputeAcceptedGains(
  oracle: Oracle,
  record: AcceptedGainRecord,
  raw: HistoricalAcceptedRawScore,
  receipt: Qualification,
  base: MainFloor,
): AcceptedGainFloor {
  assert.equal(raw.schema, 1);
  assert.equal(raw.kind, "raw-score");
  assert.deepEqual(raw.selected, record.original.binding);
  assert.equal(raw.sourceSha, record.original.binding.testedMergeSha);
  assert.deepEqual(raw.run, record.original.run);
  assert.equal(raw.inputsSha256, record.original.inputsSha256);
  assert.equal(raw.resultSha256, record.original.resultSha256);
  assert.equal(digest(raw.score), raw.resultSha256);
  validateOwnScore(oracle, raw.score);
  validateFloor(oracle, raw.floor);
  assert.equal(raw.floor.sourceSha, record.original.binding.mainSha);
  assert.equal(raw.floor.floorSha256, record.original.capturedFloorSha256);
  const expected = qualification(oracle, raw.floor, raw.score, raw.selected);
  const { observedMainAfter: _observed, ...actual } = receipt;
  assert.deepEqual(actual, expected, "original qualification differs from recomputation");
  assert.equal(expected.ok, true, "original losses");
  assert.equal(
    digest(
      raw.score.cases.map(({ id, corpus, category, kind, excluded }) => ({
        id,
        corpus,
        category,
        kind,
        ...(excluded === undefined ? {} : { excluded }),
      })),
    ),
    record.rowIdentitySha256,
    "frozen row metadata",
  );
  const skips = raw.score.cases
    .filter((item) => item.outcome === "skip")
    .map((item) => item.id)
    .sort();
  assert.equal(digest(skips), record.skipMembershipSha256, "frozen skip membership");
  const gained = Object.values(expected.corpora)
    .flatMap((row) => row.gained)
    .sort();
  assert.deepEqual(record.gains, gained, "stored gains differ from recomputation");
  assert.equal(record.gainsSha256, digest(gained), "gain membership digest");
  validateFloor(oracle, base);
  assert.equal(base.sourceSha, record.baseFloor.sourceSha);
  assert.equal(base.sourceSha, record.landed.firstParent);
  assert.deepEqual(base.run, record.baseFloor.run);
  assert.equal(base.floorSha256, record.baseFloor.floorSha256);
  assert.deepEqual(base.lostIds, [], "base floor losses");
  const ids = Array.from(new Set(base.floorIds.concat(gained))).sort();
  return immutable({
    kind: "AcceptedGainFloor",
    base,
    landedMerge: merge,
    acceptedRecordDigest: digest(record),
    gained,
    ids,
    floorSha256: digest(ids),
  });
}
async function acceptedFloor(
  root: string,
  client: GithubClient,
  oracle: Oracle,
  record: AcceptedRecord,
  lifetime: Lifetime,
): Promise<AcceptedGainFloor> {
  const pr = await requestPullRequest(client, `/pulls/${record.landed.pr}`);
  assertGit(root, record, pr);
  const run = await requestRun(
    client,
    `/actions/runs/${record.original.run.runId}/attempts/${record.original.run.attempt}`,
  );
  assertRun(run, record);
  const jobs = await jobsFor(client, run);
  const workflow = git(root, [
    "show",
    `${record.original.binding.testedMergeSha}:${authority.workflowPath}`,
  ]);
  assertHistoricalJobs(run, jobs, workflow, pr.merged_at);
  const raw = await artifact(
    client,
    run,
    jobs,
    workflow,
    record.artifacts.raw,
    "raw",
    record.original.binding.testedMergeSha,
    lifetime,
  );
  assertHistoricalRaw(raw);
  const receipt = await artifact(
    client,
    run,
    jobs,
    workflow,
    record.artifacts.qualification,
    "qualification",
    record.original.binding.testedMergeSha,
    lifetime,
  );
  assertQualification(receipt);
  const baseRun = await requestRun(
    client,
    `/actions/runs/${record.baseFloor.run.runId}/attempts/${record.baseFloor.run.attempt}`,
  );
  assertMainRun(baseRun, record.landed.firstParent, record.baseFloor.run.attempt);
  assert.equal(baseRun.id, record.baseFloor.run.runId);
  const baseJobs = await jobsFor(client, baseRun);
  const baseWorkflow = git(root, [
    "show",
    `${record.landed.firstParent}:${authority.workflowPath}`,
  ]);
  assertHistoricalJobs(baseRun, baseJobs, baseWorkflow, new Date().toISOString());
  const base = await artifact(
    client,
    baseRun,
    baseJobs,
    baseWorkflow,
    record.artifacts.baseFloor,
    "floor",
    record.landed.firstParent,
    lifetime,
  );
  assertMainFloor(base);
  return recomputeAcceptedGains(oracle, record, raw, receipt, base);
}

async function observedOrTerminalFloor(
  context: PreparationContext & { target: string; sourceSha: string; selected: Binding },
): Promise<PreparedFloor> {
  const { root, client, target } = context;
  try {
    return {
      kind: "MainObservedFloor",
      floor: (await resolveMainFloor({ root, sourceSha: target, client })).floor,
    };
  } catch (error) {
    if (!terminalGap(error)) throw error;
    return prepareTerminalRecovery(context);
  }
}
/** Resolves only the captured candidate's requirement, never a replacement main observation. */
export async function prepareCandidate({
  root,
  client,
  selected,
  sourceSha,
  run,
}: {
  root: string;
  client: GithubClient;
  selected: Binding;
  sourceSha: string;
  run: RunBinding;
}): Promise<PreparedCandidate> {
  const target = selected.kind === "pull-request" ? selected.mainSha : selected.beforeSha;
  const oracle = oracleAt(root, bootstrap.sourceSha);
  let floor: PreparedFloor;
  const lifetime = { expires: Infinity };
  if (target !== merge) {
    floor = await observedOrTerminalFloor({
      root,
      client,
      target,
      oracle,
      sourceSha,
      selected,
      lifetime,
    });
  } else {
    const found = await mainEvidence({ root, oracle, client }).collect(target);
    if (found.floors.length || found.scores.length)
      floor = {
        kind: "MainObservedFloor",
        floor: (await resolveMainFloor({ root, sourceSha: target, client })).floor,
      };
    else {
      await terminalBlock(client);
      floor = await acceptedFloor(
        root,
        client,
        oracle,
        candidateRecord(root, selected, sourceSha),
        lifetime,
      );
    }
  }
  const prepared = immutable({
    floor,
    sourceSha,
    selected: structuredClone(selected),
    run: structuredClone(run),
  });
  preparations.set(prepared, { root, client, oracle, lifetime });
  return prepared;
}
function comparisonFloor(floor: PreparedFloor): MainFloor {
  if (floor.kind === "MainObservedFloor") return floor.floor;
  // Only the comparator needs a main-floor-shaped set. Its source remains actual base d6, never f6.
  return { ...floor.base, floorIds: floor.ids, floorSha256: floor.floorSha256 };
}
export function assertFreshObservation(
  raw: Pick<AcceptedRawScore, "capturedAt">,
  producer: Pick<HostJob, "steps">,
): void {
  const bound = step(producer, "Bind qualification and resolve PR main floor");
  const observed = step(producer, "Observe compatibility with the same-job node build");
  const sealed = step(producer, "Seal complete raw score");
  assert.ok(bound.number < observed.number && observed.number < sealed.number, "observer order");
  assert.ok(
    time(raw.capturedAt) >= time(bound.started_at) &&
      time(raw.capturedAt) <= time(bound.completed_at) + 1000,
    "preparation time outside bound job",
  );
  assertObservationSequence(raw, bound, observed, sealed);
}
async function terminalObservationJobs(
  raw: AcceptedRawScore,
  context: PreparationContext,
  sealerJobs: HostJob[],
): Promise<{
  observer: HostJob;
  sealer: HostJob;
  observerAttempt: number;
}> {
  const observationRun = raw.observationRun;
  assertRunBinding(observationRun);
  assert.equal(observationRun.runId, raw.run.runId, "wrong observation run");
  assert.ok(observationRun.attempt <= raw.run.attempt, "observation comes from a later attempt");
  const observation = await admitObservation({
    root: context.root,
    client: context.client,
    oracle: context.oracle,
    ...observationRun,
    sourceSha: raw.sourceSha,
    selected: raw.selected,
  });
  assert.equal(digest(observation.score), raw.resultSha256, "observation score mismatch");
  assert.equal(observation.input.capturedAt, raw.capturedAt, "observation capture mismatch");
  assert.deepEqual(observation.input.floor, raw.floor, "observation floor mismatch");
  return {
    observer: observation.job,
    sealer: unique(
      sealerJobs,
      (item) => item.name === "own-shell-compatibility",
      "rerun raw sealer",
    ),
    observerAttempt: observation.run.run_attempt,
  };
}
async function freshObservation(
  prepared: PreparedCandidate,
  raw: AcceptedRawScore,
  context: PreparationContext,
): Promise<object> {
  assert.deepEqual(raw.selected, prepared.selected, "observation binding");
  assert.equal(raw.sourceSha, prepared.sourceSha);
  assert.deepEqual(raw.run, prepared.run, "observation run/attempt");
  assert.equal(raw.inputsSha256, digest(scoringInputs(context.root, raw.sourceSha)));
  assert.equal(raw.resultSha256, digest(raw.score));
  validateOwnScore(context.oracle, raw.score);
  const evidence = await admitQualificationRaw({ root: context.root, client: context.client, raw });
  const metadata = await requestArtifact(
    context.client,
    `/actions/artifacts/${evidence.artifactId}`,
  );
  assert.equal(metadata.id, evidence.artifactId);
  assert.equal(metadata.digest, `sha256:${evidence.archiveSha256}`, "observation metadata digest");
  assert.equal(metadata.expired, false, "expired observation artifact");
  assert.ok(time(metadata.expires_at) > Date.now(), "observation artifact expired by timestamp");
  const host = await requestRun(
    context.client,
    `/actions/runs/${raw.run.runId}/attempts/${raw.run.attempt}`,
  );
  const jobs = await jobsFor(context.client, host);
  const producer = unique(
    jobs,
    (item) => item.name === "own-shell-compatibility",
    "fresh Waffle producer",
  );
  if (prepared.floor.recovery === "terminal-2026-10-29") {
    const provenance = await terminalObservationJobs(raw, context, jobs);
    assertTerminalFreshObservation(raw, provenance);
  } else assertFreshObservation(raw, producer);
  assert.equal(context.oracle.environment.runner, "waffle-node", "real Waffle instrument required");
  const observation = Object.freeze({});
  observations.set(observation, structuredClone(raw));
  return observation;
}
/** Reconstructs observation authority from the immutable producer, not serialized brands or booleans. */
export async function foldCandidate(
  prepared: PreparedCandidate,
  raw: AcceptedRawScore,
): Promise<Qualification> {
  const context = preparations.get(prepared);
  assert.ok(context, "forged preparation");
  assert.ok(context.lifetime.expires > Date.now(), "expired preparation evidence");
  const accepted = prepared.floor;
  assert.ok(accepted.kind === "AcceptedGainFloor", "normal qualification uses the existing path");
  assert.deepEqual(raw.floor, prepared.floor, "captured accepted requirement changed");
  const observation = await freshObservation(prepared, raw, context);
  const admitted = observations.get(observation);
  assert.ok(admitted, "forged Waffle observation");
  const result = qualification(
    context.oracle,
    comparisonFloor(prepared.floor),
    admitted.score,
    prepared.selected,
  );
  assert.equal(result.ok, true, "accepted passing IDs were lost");
  return { ...result, floorSource: prepared.floor };
}
