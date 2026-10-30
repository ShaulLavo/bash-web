import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import {
  accumulateFloor,
  assertMainFloor,
  bootstrap,
  bootstrapFloor,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.ts";
import type { FloorEvidence, MainFloor } from "./shell-scoreboard-floor.ts";
import {
  assertBinding,
  assertOracle,
  assertRecord,
  assertRunBinding,
  assertScore,
  bytesDigest,
  digest,
  verifyOracle,
} from "./shell-scoreboard.ts";
import type { Binding, Oracle, PullRequestBinding, RunBinding, Score } from "./shell-scoreboard.ts";

export const authority = Object.freeze({
  repository: "ShaulLavo/bash-web",
  repositoryId: 1423683647,
  workflowId: 387934034,
  workflowPath: ".github/workflows/ci.yml",
});
const contracts = {
  raw: {
    job: "own-shell-compatibility",
    observe: "Seal complete raw score",
    upload: "Upload complete raw score",
    prefix: "own-shell-raw",
  },
  observation: {
    job: "own-shell-observation",
    bind: "Bind qualification and resolve PR main floor",
    observe: "Observe compatibility with the shared node build",
    upload: "Run actions/upload-artifact@v4",
    uploadId: "current-upload",
    prefix: "own-shell-current",
    optionalFile: true,
  },
  qualification: {
    job: "score-floor",
    observe: "Fold main floor and qualification",
    upload: "Upload gained and lost IDs",
    prefix: "own-shell-qualification",
  },
  floor: {
    job: "score-floor",
    observe: "Fold main floor and qualification",
    upload: "Upload cumulative main floor",
    prefix: "own-shell-floor",
  },
};
export type ArtifactKind = keyof typeof contracts;
interface HostRepository {
  id: number;
  [key: string]: unknown;
}
export interface HostStep {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  number: number;
  [key: string]: unknown;
}
export interface CompletedHostStep extends HostStep {
  started_at: string;
  completed_at: string;
}
export interface HostJob {
  id: number;
  name: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  steps: HostStep[];
  [key: string]: unknown;
}
export interface HostRunSummary {
  id: number;
  run_attempt: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  [key: string]: unknown;
}
export interface HostRun extends HostRunSummary {
  repository?: HostRepository;
  head_repository: HostRepository;
  workflow_id: number;
  path: string;
  event: string;
  head_branch: string;
  [key: string]: unknown;
}
export interface HostArtifact {
  id: number;
  name: string;
  expired: boolean;
  digest: string;
  created_at: string;
  expires_at?: string;
  workflow_run?: {
    id: number;
    head_sha: string;
    head_repository_id: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface WorkflowRunListing {
  total_count: number;
  workflow_runs: HostRunSummary[];
}
export interface JobListing {
  total_count: number;
  jobs: HostJob[];
}
export interface ArtifactListing {
  total_count: number;
  artifacts: HostArtifact[];
}
export interface PullRequest {
  number: number;
  merged: boolean;
  base: { ref: string; repo: HostRepository };
  head: { sha: string; repo: HostRepository };
  merge_commit_sha: string;
  merged_at: string;
  [key: string]: unknown;
}
export interface UploaderEvidence {
  runId: number;
  attempt: number;
  jobId: number;
  artifactId: number;
  archiveSha256: string;
  uploaderLogsSha256: string;
}
export interface RawScore<Floor = MainFloor> {
  schema: number;
  kind: string;
  selected: Binding;
  run: RunBinding;
  sourceSha: string;
  capturedAt?: string;
  floor?: Floor | null;
  inputsSha256: string;
  resultSha256: string;
  score: Score;
  observedMainAfter?: string | null;
  [key: string]: unknown;
}
export interface LandedRecord {
  landed: { pr: number; mergeCommit: string; [key: string]: unknown };
  original: { binding: PullRequestBinding; [key: string]: unknown };
}
export interface EvidenceSet {
  floors: MainFloor[];
  scores: Score[];
  evidence: FloorEvidence[];
}
export interface GithubClient {
  request(path: string, type: "bytes"): Promise<Buffer>;
  request(path: string, type: "text"): Promise<string>;
  request(path: string, type?: "json"): Promise<unknown>;
}
type ResponseType = "json" | "bytes" | "text";

class FloorPrerequisite extends Error {
  readonly reason: string;
  readonly sourceSha: string;
  constructor(reason: string, sourceSha: string) {
    super(
      `scoreboard prerequisite: ${reason} for ${sourceSha}; retry the exact qualification/floor job after its evidence is available; no historical replay was started`,
    );
    this.name = "FloorPrerequisite";
    this.reason = reason;
    this.sourceSha = sourceSha;
  }
}
export function fullSha(value: unknown): string {
  assert.ok(typeof value === "string", "missing source SHA");
  assert.match(value, /^[a-f0-9]{40}$/, "expected immutable full source SHA");
  return value;
}
function positive(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "expected positive host ID/attempt",
  );
  return value;
}
function assertRepository(value: unknown): asserts value is HostRepository {
  assertRecord(value);
  positive(value.id);
}
function assertHostStep(value: unknown): asserts value is HostStep {
  assertRecord(value);
  assert.equal(typeof value.name, "string", "missing step name");
  assert.equal(typeof value.status, "string", "missing step status");
  assert.ok(
    value.conclusion === null || typeof value.conclusion === "string",
    "invalid step conclusion",
  );
  assert.ok(
    value.started_at === null || typeof value.started_at === "string",
    "invalid step start",
  );
  assert.ok(
    value.completed_at === null || typeof value.completed_at === "string",
    "invalid step completion",
  );
  positive(value.number);
}
function assertHostJob(value: unknown): asserts value is HostJob {
  assertRecord(value);
  positive(value.id);
  assert.equal(typeof value.name, "string", "missing job name");
  positive(value.run_id);
  positive(value.run_attempt);
  assert.equal(typeof value.head_sha, "string", "missing host source");
  assert.equal(typeof value.status, "string", "missing job status");
  assert.ok(
    value.conclusion === null || typeof value.conclusion === "string",
    "invalid job conclusion",
  );
  assert.ok(Array.isArray(value.steps), "missing job steps");
  for (const step of value.steps) assertHostStep(step);
}
function assertHostRunSummary(value: unknown): asserts value is HostRunSummary {
  assertRecord(value);
  positive(value.id);
  positive(value.run_attempt);
  assert.equal(typeof value.head_sha, "string", "missing host source");
  assert.equal(typeof value.status, "string", "missing run status");
  assert.ok(
    value.conclusion === null || typeof value.conclusion === "string",
    "invalid run conclusion",
  );
}
export function assertHostRun(value: unknown): asserts value is HostRun {
  assertHostRunSummary(value);
  if (value.repository !== undefined) assertRepository(value.repository);
  assertRepository(value.head_repository);
  positive(value.workflow_id);
  assert.equal(typeof value.path, "string", "missing workflow path");
  assert.equal(typeof value.event, "string", "missing run event");
  assert.equal(typeof value.head_branch, "string", "missing run branch");
}
export function assertHostArtifact(value: unknown): asserts value is HostArtifact {
  assertRecord(value);
  positive(value.id);
  assert.equal(typeof value.name, "string", "missing artifact name");
  assert.equal(typeof value.expired, "boolean", "missing artifact expiry");
  assert.equal(typeof value.digest, "string", "missing artifact digest");
  assert.equal(typeof value.created_at, "string", "missing artifact creation time");
  if (value.expires_at !== undefined)
    assert.equal(typeof value.expires_at, "string", "invalid artifact expiry");
  if (value.workflow_run === undefined) return;
  assertRecord(value.workflow_run);
  positive(value.workflow_run.id);
  assert.equal(typeof value.workflow_run.head_sha, "string", "missing artifact source");
  positive(value.workflow_run.head_repository_id);
}
function assertListing(
  value: unknown,
): asserts value is Record<string, unknown> & { total_count: number } {
  assertRecord(value);
  assert.ok(
    typeof value.total_count === "number" &&
      Number.isSafeInteger(value.total_count) &&
      value.total_count >= 0,
    "invalid host listing count",
  );
}
function assertWorkflowRunListing(value: unknown): asserts value is WorkflowRunListing {
  assertListing(value);
  assertRecord(value);
  assert.ok(Array.isArray(value.workflow_runs), "missing workflow runs");
  for (const run of value.workflow_runs) assertHostRunSummary(run);
}
export function assertJobListing(value: unknown): asserts value is JobListing {
  assertListing(value);
  assertRecord(value);
  assert.ok(Array.isArray(value.jobs), "missing jobs");
  for (const job of value.jobs) assertHostJob(job);
}
export function assertArtifactListing(value: unknown): asserts value is ArtifactListing {
  assertListing(value);
  assertRecord(value);
  assert.ok(Array.isArray(value.artifacts), "missing artifacts");
  for (const artifact of value.artifacts) assertHostArtifact(artifact);
}
export function assertPullRequest(value: unknown): asserts value is PullRequest {
  assertRecord(value);
  positive(value.number);
  assert.equal(typeof value.merged, "boolean", "missing pull request merge state");
  assertRecord(value.base);
  assert.equal(typeof value.base.ref, "string", "missing pull request base ref");
  assertRepository(value.base.repo);
  assertRecord(value.head);
  assert.equal(typeof value.head.sha, "string", "missing pull request head");
  assertRepository(value.head.repo);
  assert.equal(typeof value.merge_commit_sha, "string", "missing merge commit");
  assert.equal(typeof value.merged_at, "string", "missing merge time");
}
export function assertRawScore(value: unknown): asserts value is RawScore<unknown> {
  assertRecord(value);
  assertBinding(value.selected);
  assertRunBinding(value.run);
  fullSha(value.sourceSha);
  if (value.capturedAt !== undefined)
    assert.equal(typeof value.capturedAt, "string", "invalid raw capture time");
  assert.equal(typeof value.inputsSha256, "string", "missing raw input digest");
  assert.equal(typeof value.resultSha256, "string", "missing raw result digest");
  assertScore(value.score);
}
export async function requestRun(client: GithubClient, path: string): Promise<HostRun> {
  const value = await client.request(path);
  assertHostRun(value);
  return value;
}
export async function requestJobs(client: GithubClient, path: string): Promise<JobListing> {
  const value = await client.request(path);
  assertJobListing(value);
  return value;
}
export async function requestArtifacts(
  client: GithubClient,
  path: string,
): Promise<ArtifactListing> {
  const value = await client.request(path);
  assertArtifactListing(value);
  return value;
}
export async function requestWorkflowRuns(
  client: GithubClient,
  path: string,
): Promise<WorkflowRunListing> {
  const value = await client.request(path);
  assertWorkflowRunListing(value);
  return value;
}
export async function requestArtifact(client: GithubClient, path: string): Promise<HostArtifact> {
  const value = await client.request(path);
  assertHostArtifact(value);
  return value;
}
export async function requestPullRequest(client: GithubClient, path: string): Promise<PullRequest> {
  const value = await client.request(path);
  assertPullRequest(value);
  return value;
}
function gitBytes(root: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
export function git(root: string, args: string[]): string {
  return gitBytes(root, args).toString("utf8").trimEnd();
}
export function assertAcceptedRecordCheckout(root: string, sourceSha: string): void {
  assert.equal(git(root, ["rev-parse", "HEAD"]), fullSha(sourceSha), "candidate checkout changed");
  assert.equal(
    git(root, ["diff", "--name-only", sourceSha, "--", "scoreboard/accepted-gains"]),
    "",
    "mutable accepted records",
  );
  assert.equal(
    git(root, ["ls-files", "--others", "--exclude-standard", "--", "scoreboard/accepted-gains"]),
    "",
    "unbound accepted records",
  );
}
export function assertJobBinding(
  job: Pick<HostJob, "run_id" | "run_attempt" | "head_sha">,
  run: Pick<HostRun, "id" | "run_attempt" | "head_sha">,
): void {
  assert.equal(job.run_id, run.id, "wrong job run");
  assert.equal(job.run_attempt, run.run_attempt, "wrong job attempt");
  assert.equal(job.head_sha, run.head_sha, "wrong job source");
}
export function assertLandedPullRequest(pr: PullRequest, { landed, original }: LandedRecord): void {
  assert.equal(pr.number, landed.pr);
  assert.equal(pr.merged, true, "unmerged record cannot certify candidate");
  assert.equal(pr.base.ref, "main");
  assert.equal(pr.base.repo.id, authority.repositoryId);
  assert.equal(pr.head.repo.id, authority.repositoryId);
  assert.equal(pr.head.sha, original.binding.headSha);
  assert.equal(pr.merge_commit_sha, landed.mergeCommit);
}
export function assertObservationSequence(
  raw: Pick<RawScore, "capturedAt">,
  bound: CompletedHostStep,
  observed: CompletedHostStep,
  sealed: CompletedHostStep,
): void {
  const capturedAt = raw.capturedAt ?? "";
  assert.ok(
    Date.parse(observed.started_at) >= Date.parse(bound.completed_at) &&
      Date.parse(observed.completed_at) > Date.parse(capturedAt) &&
      Date.parse(observed.completed_at) <= Date.parse(sealed.started_at),
    "stale Waffle observation",
  );
}
export function oracleAt(root: string, sourceSha: string): Oracle {
  fullSha(sourceSha);
  const bytes = gitBytes(root, ["show", `${sourceSha}:docs/evidence/own-shell-oracle.json`]);
  const pins: unknown = JSON.parse(git(root, ["show", `${sourceSha}:sources.lock.json`]));
  assertRecord(pins);
  assertRecord(pins.shellScoreboard);
  assert.equal(
    bytesDigest(bytes),
    pins.shellScoreboard.oracleSha256,
    "trusted source oracle checksum",
  );
  const oracle: unknown = JSON.parse(bytes.toString("utf8"));
  assertOracle(oracle);
  verifyOracle(oracle);
  return oracle;
}
function documentation(path: string): boolean {
  return path === "README.md" || path === "AGENTS.md" || /^docs\/.+\.md$/.test(path);
}
export function scoringInputs(root: string, sourceSha: string): string[] {
  fullSha(sourceSha);
  const records = git(root, ["ls-tree", "-r", "-z", sourceSha]).split("\0").filter(Boolean);
  return records.filter((record) => {
    const path = record.slice(record.indexOf("\t") + 1);
    return !record.startsWith("100644 blob ") || !documentation(path);
  });
}
function inputEquivalence(root: string, left: string, right: string) {
  const beforeInputsSha256 = digest(scoringInputs(root, left));
  const sourceInputsSha256 = digest(scoringInputs(root, right));
  return {
    equivalent: beforeInputsSha256 === sourceInputsSha256,
    beforeInputsSha256,
    sourceInputsSha256,
  };
}
export function sourceEquivalent(root: string, left: string, right: string): boolean {
  return inputEquivalence(root, left, right).equivalent;
}
export function firstParent(root: string, sourceSha: string): string {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", fullSha(sourceSha)]).split(" ");
  assert.equal(parents[0], sourceSha);
  if (!parents[1]) throw new FloorPrerequisite("missing-main-predecessor", sourceSha);
  return fullSha(parents[1]);
}
export function assertMainRun(run: HostRun, sourceSha: string, attempt: number): void {
  assert.equal(run.repository?.id, authority.repositoryId, "wrong host repository");
  assert.equal(run.head_repository?.id, authority.repositoryId, "wrong head repository");
  assert.equal(run.workflow_id, authority.workflowId, "wrong workflow ID");
  assert.equal(run.path, authority.workflowPath, "wrong workflow path");
  assert.equal(run.event, "push", "PR/manual result is not main authority");
  assert.equal(run.head_branch, "main", "wrong host branch");
  assert.equal(run.head_sha, fullSha(sourceSha), "wrong host source");
  assert.equal(run.run_attempt, positive(attempt), "wrong run attempt");
  positive(run.id);
}
export function hasStepTimes(step: HostStep): step is CompletedHostStep {
  return (
    step.started_at !== null &&
    step.completed_at !== null &&
    Number.isFinite(Date.parse(step.started_at)) &&
    Number.isFinite(Date.parse(step.completed_at))
  );
}
function successfulStep(job: HostJob, name: string): CompletedHostStep {
  const selected = job.steps.filter((step) => step.name === name);
  assert.equal(selected.length, 1, `missing/ambiguous producer step ${name}`);
  const step = selected[0];
  assert.equal(step.status, "completed", `unfinished ${name}`);
  assert.equal(step.conclusion, "success", `unsuccessful ${name}`);
  assert.ok(hasStepTimes(step), "missing host step times");
  return step;
}
function assertJobIdentity(job: HostJob, run: HostRun): void {
  assert.equal(job.run_id, run.id, "wrong producer run");
  assert.equal(job.run_attempt, run.run_attempt, "old producer attempt");
  assert.equal(job.head_sha, run.head_sha, "wrong producer source");
  positive(job.id);
}
export function assertUploader({
  run,
  job,
  artifact,
  kind,
  workflow,
  logs,
  testedSource = run.head_sha,
}: {
  run: HostRun;
  job: HostJob;
  artifact: HostArtifact;
  kind: ArtifactKind;
  workflow: string;
  logs: string;
  testedSource?: string;
}): UploaderEvidence {
  const contract = contracts[kind];
  assert.ok(contract, "unknown artifact kind");
  assert.equal(job.name, contract.job, "wrong producer job");
  assert.equal(job.run_id, run.id, "wrong producer run");
  assert.equal(job.run_attempt, run.run_attempt, "old producer attempt");
  assert.equal(job.head_sha, run.head_sha, "wrong producer source");
  assert.equal(job.status, "completed", "unfinished producer");
  assert.ok(
    kind === "floor"
      ? ["success", "failure"].includes(job.conclusion ?? "")
      : job.conclusion === "success",
    "cancelled/failed raw producer",
  );
  positive(job.id);
  const observed = successfulStep(job, contract.observe);
  const uploaded = successfulStep(job, contract.upload);
  assert.ok(observed.number < uploaded.number, "upload must follow complete observation");
  for (const step of job.steps) {
    if (["success", "skipped"].includes(step.conclusion ?? "")) continue;
    assert.ok(
      kind === "floor" && step.name === "Enforce qualification" && step.conclusion === "failure",
      "unexpected failed producer step",
    );
  }
  const definition: unknown = parse(workflow);
  assertRecord(definition);
  assertRecord(definition.jobs);
  const expression = `${contract.prefix}-\${{ github.sha }}-\${{ github.run_id }}-\${{ github.run_attempt }}`;
  const uploaders = Object.entries(definition.jobs).flatMap(([owner, value]) => {
    assertRecord(value);
    const steps = Array.isArray(value.steps) ? value.steps : [];
    return steps.flatMap((step) => {
      assertRecord(step);
      if (step.uses !== "actions/upload-artifact@v4") return [];
      assertRecord(step.with);
      if (step.with.name !== expression) return [];
      return [{ owner, step }];
    });
  });
  assert.equal(uploaders.length, 1, "reviewed workflow must have one unique uploader expression");
  const uploader = uploaders[0];
  assert.equal(uploader.owner, contract.job, "wrong reviewed uploader owner");
  assertRecord(uploader.step.with);
  if ("uploadId" in contract && contract.uploadId) {
    assert.equal(uploader.step.id, contract.uploadId, "wrong reviewed upload step ID");
    assert.equal(uploader.step.name, undefined, "observation upload step must be unnamed");
  } else assert.equal(uploader.step.name, contract.upload, "wrong reviewed upload step");
  assert.equal(
    uploader.step.with["if-no-files-found"],
    "optionalFile" in contract && contract.optionalFile ? "ignore" : "error",
    "optionalFile" in contract && contract.optionalFile
      ? "observation uploader must tolerate missing files"
      : "uploader must require a file",
  );
  assert.ok(!uploader.step.with.overwrite, "immutable uploads cannot overwrite");
  const name = `${contract.prefix}-${fullSha(testedSource)}-${run.id}-${run.run_attempt}`;
  assert.equal(artifact.name, name, "artifact source/run/attempt name mismatch");
  assert.equal(artifact.workflow_run?.id, run.id, "wrong artifact run");
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, "wrong artifact source");
  assert.equal(
    artifact.workflow_run?.head_repository_id,
    run.head_repository.id,
    "wrong artifact repository",
  );
  positive(artifact.id);
  assert.equal(artifact.expired, false, "expired artifact");
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/, "missing host artifact digest");
  assertUploadLog({ artifact, uploaded, logs, name });
  return {
    runId: run.id,
    attempt: run.run_attempt,
    jobId: job.id,
    artifactId: artifact.id,
    archiveSha256: artifact.digest.slice(7),
    uploaderLogsSha256: bytesDigest(logs),
  };
}

function assertUploadLog({
  artifact,
  uploaded,
  logs,
  name,
}: {
  artifact: HostArtifact;
  uploaded: CompletedHostStep;
  logs: string;
  name: string;
}): void {
  const created = Date.parse(artifact.created_at);
  assert.ok(
    created >= Date.parse(uploaded.started_at) &&
      created < Date.parse(uploaded.completed_at) + 1000,
    "artifact is outside this upload step",
  );
  const lines = logs
    .split("\n")
    .filter((line) => {
      const time = Date.parse(line.slice(0, line.indexOf(" ")));
      return (
        time >= Date.parse(uploaded.started_at) && time < Date.parse(uploaded.completed_at) + 1000
      );
    })
    .join("\n");
  assert.ok(
    lines.includes(`Artifact ${name} has been successfully uploaded!`),
    "job logs do not bind the reviewed uploader",
  );
  assert.ok(
    lines.includes(`bytes. Artifact ID is ${artifact.id}\n`) ||
      lines.endsWith(`bytes. Artifact ID is ${artifact.id}`),
    "artifact ID not produced by this job",
  );
  assert.ok(
    lines.includes(`SHA256 digest of uploaded artifact zip is ${artifact.digest.slice(7)}`),
    "uploader digest differs from host artifact",
  );
}

const unzipJson = String.raw`import io,json,posixpath,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 names=z.namelist()
 if len(names)!=len(set(names)): raise ValueError('duplicate archive members')
 if any(n.startswith('/') or '..' in n.split('/') or '\\' in n for n in names): raise ValueError('unsafe archive member')
 if sum(i.file_size for i in z.infolist())>67108864: raise ValueError('archive too large')
 target=sys.argv[1]
 if names.count(target)!=1 or z.getinfo(target).file_size>16777216: raise ValueError('missing/oversized JSON member')
 if sys.argv[2]=='exact' and names!=[target]: raise ValueError('unexpected archive members')
 sys.stdout.buffer.write(z.read(target))`;
export function artifactJson(
  bytes: Buffer,
  artifact: Pick<HostArtifact, "digest">,
  member: string,
  exact = true,
): unknown {
  assert.ok(bytes.byteLength <= 16 * 1024 * 1024, "artifact archive too large");
  assert.equal(`sha256:${bytesDigest(bytes)}`, artifact.digest, "archive digest mismatch");
  const value: unknown = JSON.parse(
    execFileSync("python3", ["-c", unzipJson, member, exact ? "exact" : "bootstrap"], {
      input: bytes,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  return value;
}
export function githubClient(token: string | undefined): GithubClient {
  assert.ok(token, "missing read-only workflow token");
  const cache = new Map<string, Promise<unknown>>();
  async function fetchResponse(path: string, type: ResponseType): Promise<unknown> {
    assert.ok(path.startsWith("/") && !path.includes(".."), "invalid host API path");
    const response = await fetch(`https://api.github.com/repos/${authority.repository}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new FloorPrerequisite(`host-evidence-${response.status}`, path);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length <= 32 * 1024 * 1024, "oversized host response");
    if (type === "bytes") return bytes;
    if (type === "text") return bytes.toString("utf8");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value;
  }
  function request(path: string, type: "bytes"): Promise<Buffer>;
  function request(path: string, type: "text"): Promise<string>;
  function request(path: string, type?: "json"): Promise<unknown>;
  function request(path: string, type: ResponseType = "json"): Promise<unknown> {
    const key = `${type}:${path}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = fetchResponse(path, type);
    cache.set(key, pending);
    return pending;
  }
  return { request };
}
export function mainEvidence({
  root,
  oracle,
  client,
}: {
  root: string;
  oracle: Oracle;
  client: GithubClient;
}) {
  const cache = new Map<string, EvidenceSet>();
  async function collect(sourceSha: string): Promise<EvidenceSet> {
    const cached = cache.get(sourceSha);
    if (cached) return cached;
    const listing = await requestWorkflowRuns(
      client,
      `/actions/workflows/${authority.workflowId}/runs?event=push&head_sha=${fullSha(sourceSha)}&per_page=100`,
    );
    if (listing.total_count > 100) throw new FloorPrerequisite("too-many-source-runs", sourceSha);
    const result: EvidenceSet = { floors: [], scores: [], evidence: [] };
    for (const run of listing.workflow_runs) await collectRun(run, sourceSha, result);
    cache.set(sourceSha, result);
    return result;
  }
  async function collectRun(
    summary: HostRunSummary,
    sourceSha: string,
    result: EvidenceSet,
  ): Promise<void> {
    if (summary.run_attempt > 32)
      throw new FloorPrerequisite("too-many-source-attempts", sourceSha);
    const artifacts = await requestArtifacts(
      client,
      `/actions/runs/${positive(summary.id)}/artifacts?per_page=100`,
    );
    if (artifacts.total_count > 100)
      throw new FloorPrerequisite("too-many-run-artifacts", sourceSha);
    for (let attempt = 1; attempt <= summary.run_attempt; attempt++)
      await collectAttempt(summary.id, attempt, sourceSha, artifacts.artifacts, result);
  }
  async function collectAttempt(
    runId: number,
    attempt: number,
    sourceSha: string,
    artifacts: HostArtifact[],
    result: EvidenceSet,
  ): Promise<void> {
    const run = await requestRun(client, `/actions/runs/${runId}/attempts/${attempt}`);
    assertMainRun(run, sourceSha, attempt);
    assert.equal(run.id, runId, "host run ID mismatch");
    const jobs = await requestJobs(
      client,
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    );
    assert.ok(jobs.total_count <= 100, "too many producer jobs");
    const scores = result.scores.length;
    const kinds: ("raw" | "floor")[] = ["raw", "floor"];
    for (const kind of kinds) await collectArtifact(run, jobs.jobs, artifacts, kind, result);
    if (result.scores.length === scores)
      await collectObservation(run, jobs.jobs, artifacts, result);
  }
  async function collectArtifact(
    run: HostRun,
    jobs: HostJob[],
    artifacts: HostArtifact[],
    kind: "raw" | "floor",
    result: EvidenceSet,
  ): Promise<void> {
    const contract = contracts[kind];
    const matches = artifacts.filter(
      (artifact) =>
        artifact.name === `${contract.prefix}-${run.head_sha}-${run.id}-${run.run_attempt}`,
    );
    assert.ok(matches.length <= 1, "ambiguous immutable artifact");
    if (!matches.length) return;
    if (matches[0].expired) throw new FloorPrerequisite("expired-source-artifact", run.head_sha);
    const producers = jobs.filter((job) => job.name === contract.job);
    assert.ok(producers.length <= 1, "ambiguous producer job");
    if (!producers.length || producers[0].status !== "completed") return;
    const job = producers[0];
    if (job.conclusion === "cancelled") return;
    const logs = await client.request(`/actions/jobs/${job.id}/logs`, "text");
    const workflow = git(root, ["show", `${run.head_sha}:${authority.workflowPath}`]);
    const artifact = matches[0];
    const evidence = assertUploader({ run, job, artifact, kind, workflow, logs });
    const bytes = await client.request(`/actions/artifacts/${artifact.id}/zip`, "bytes");
    const value = artifactJson(bytes, artifact, kind === "raw" ? "raw.json" : "floor.json");
    if (kind === "floor") {
      assertMainFloor(value);
      assert.equal(value.sourceSha, run.head_sha, "payload source mismatch");
      assert.deepEqual(
        value.run,
        { runId: run.id, attempt: run.run_attempt },
        "payload attempt mismatch",
      );
      result.floors.push(validateFloor(oracle, value));
    } else {
      assertRawScore(value);
      assert.equal(value.sourceSha, run.head_sha, "payload source mismatch");
      assert.deepEqual(
        value.run,
        { runId: run.id, attempt: run.run_attempt },
        "payload attempt mismatch",
      );
      admitRaw(value, run.head_sha, result);
    }
    result.evidence.push({
      kind,
      sourceSha: run.head_sha,
      ...evidence,
      payloadSha256: digest(value),
    });
  }
  async function collectObservation(
    run: HostRun,
    jobs: HostJob[],
    artifacts: HostArtifact[],
    result: EvidenceSet,
  ): Promise<void> {
    if (run.status !== "completed" || run.conclusion !== "failure") return;
    const sealers = jobs.filter((job) => job.name === contracts.raw.job);
    if (sealers.length !== 1) return;
    const sealer = sealers[0];
    assertJobIdentity(sealer, run);
    if (sealer.status !== "completed" || sealer.conclusion !== "skipped") return;
    const rawName = `${contracts.raw.prefix}-${run.head_sha}-${run.id}-${run.run_attempt}`;
    const rawArtifacts = artifacts.filter((artifact) => artifact.name === rawName);
    assert.equal(rawArtifacts.length, 0, "skipped sealer cannot have a raw artifact");
    const scoreboards = jobs.filter((job) => job.name === "own-shell-scoreboard");
    if (
      scoreboards.length !== 1 ||
      scoreboards[0].status !== "completed" ||
      scoreboards[0].conclusion !== "failure"
    )
      return;
    assertJobIdentity(scoreboards[0], run);
    const prepares = jobs.filter((job) => job.name === "prepare");
    if (
      prepares.length !== 1 ||
      prepares[0].status !== "completed" ||
      prepares[0].conclusion !== "success"
    )
      return;
    assertJobIdentity(prepares[0], run);
    const observations = jobs.filter((job) => job.name === contracts.observation.job);
    if (
      observations.length !== 1 ||
      observations[0].status !== "completed" ||
      observations[0].conclusion !== "success"
    )
      return;
    const name = `${contracts.observation.prefix}-${run.head_sha}-${run.id}-${run.run_attempt}`;
    const matches = artifacts.filter((artifact) => artifact.name === name);
    assert.ok(matches.length <= 1, "ambiguous observation artifact");
    if (!matches.length) return;
    const artifact = matches[0];
    if (artifact.expired) throw new FloorPrerequisite("expired-source-artifact", run.head_sha);
    const workflow = git(root, ["show", `${run.head_sha}:${authority.workflowPath}`]);
    const job = observations[0];
    const evidence = assertUploader({
      run,
      job,
      artifact,
      kind: "observation",
      workflow,
      logs: await client.request(`/actions/jobs/${job.id}/logs`, "text"),
    });
    const bind = successfulStep(job, contracts.observation.bind);
    const observed = successfulStep(job, contracts.observation.observe);
    const uploaded = successfulStep(job, contracts.observation.upload);
    assert.ok(bind.number < observed.number, "bind must precede observation");
    assert.ok(observed.number < uploaded.number, "observation must precede upload");
    assert.ok(
      Date.parse(bind.completed_at) <= Date.parse(observed.started_at),
      "observation must start after bind",
    );
    const bytes = await client.request(`/actions/artifacts/${artifact.id}/zip`, "bytes");
    const input = artifactJson(bytes, artifact, "scoreboard-input.json", false);
    const score = artifactJson(bytes, artifact, "own-shell-current.json", false);
    assertRecord(input);
    assert.equal(input.sourceSha, run.head_sha, "observation source mismatch");
    assert.deepEqual(
      input.run,
      { runId: run.id, attempt: run.run_attempt },
      "observation attempt mismatch",
    );
    assert.equal(
      input.inputsSha256,
      digest(scoringInputs(root, run.head_sha)),
      "observation inputs mismatch",
    );
    assertRecord(input.selected);
    const beforeSha = fullSha(input.selected.beforeSha);
    assert.deepEqual(
      input.selected,
      { kind: "main-push", sourceSha: run.head_sha, beforeSha },
      "observation source binding mismatch",
    );
    assert.equal(
      git(root, ["merge-base", beforeSha, run.head_sha]),
      beforeSha,
      "invalid main predecessor",
    );
    assert.ok(typeof input.capturedAt === "string", "missing observation capture time");
    const capturedAt = Date.parse(input.capturedAt);
    assert.ok(
      capturedAt >= Date.parse(bind.started_at) &&
        capturedAt < Date.parse(bind.completed_at) + 1000,
      "observation capture outside bind step",
    );
    assertScore(score);
    validateOwnScore(oracle, score);
    result.scores.push(score);
    result.evidence.push({
      kind: "observation",
      sourceSha: run.head_sha,
      ...evidence,
      inputSha256: digest(input),
      payloadSha256: digest(score),
      sealer: { jobId: sealer.id, conclusion: "skipped" },
      gate: { jobId: scoreboards[0].id, conclusion: "failure" },
    });
  }
  function admitRaw(value: RawScore<unknown>, sourceSha: string, result: EvidenceSet): void {
    assert.equal(value.schema, 1);
    assert.equal(value.kind, "raw-score");
    assert.equal(
      value.inputsSha256,
      digest(scoringInputs(root, sourceSha)),
      "raw source inputs mismatch",
    );
    assert.equal(value.resultSha256, digest(value.score), "raw score digest mismatch");
    validateOwnScore(oracle, value.score);
    result.scores.push(value.score);
  }
  return { collect };
}

function qualificationEvent(selected: Binding): string {
  if (selected.kind === "pull-request") return "pull_request";
  if (selected.kind === "workflow-dispatch") return "workflow_dispatch";
  return "push";
}

export async function admitQualificationRaw<Floor>({
  root,
  client,
  raw,
}: {
  root: string;
  client: GithubClient;
  raw: RawScore<Floor>;
}): Promise<UploaderEvidence> {
  const run = await requestRun(
    client,
    `/actions/runs/${positive(raw.run.runId)}/attempts/${positive(raw.run.attempt)}`,
  );
  assert.equal(run.id, raw.run.runId, "host raw run ID mismatch");
  assert.equal(run.repository?.id, authority.repositoryId);
  if (raw.selected.kind !== "pull-request")
    assert.equal(run.head_repository?.id, authority.repositoryId);
  assert.equal(run.workflow_id, authority.workflowId);
  assert.equal(run.path, authority.workflowPath);
  assert.equal(
    run.head_sha,
    raw.selected.kind === "pull-request" ? raw.selected.headSha : raw.sourceSha,
  );
  assert.equal(run.event, qualificationEvent(raw.selected));
  assert.equal(run.run_attempt, raw.run.attempt);
  if (run.event === "push") assertMainRun(run, raw.sourceSha, raw.run.attempt);
  const jobs = await requestJobs(
    client,
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  assert.ok(jobs.total_count <= 100);
  const producers = jobs.jobs.filter((job) => job.name === contracts.raw.job);
  assert.equal(producers.length, 1, "missing unique raw producer");
  const listing = await requestArtifacts(client, `/actions/runs/${run.id}/artifacts?per_page=100`);
  assert.ok(listing.total_count <= 100);
  const artifacts = listing.artifacts.filter(
    (item) => item.name === `own-shell-raw-${raw.sourceSha}-${run.id}-${run.run_attempt}`,
  );
  assert.equal(artifacts.length, 1, "missing exact raw artifact");
  const logs = await client.request(`/actions/jobs/${producers[0].id}/logs`, "text");
  const artifact = artifacts[0];
  const evidence = assertUploader({
    run,
    job: producers[0],
    artifact,
    kind: "raw",
    workflow: git(root, ["show", `${raw.sourceSha}:${authority.workflowPath}`]),
    logs,
    testedSource: raw.sourceSha,
  });
  const bytes = await client.request(`/actions/artifacts/${artifact.id}/zip`, "bytes");
  assert.equal(
    digest(artifactJson(bytes, artifact, "raw.json")),
    digest(raw),
    "downloaded raw is not the producer artifact",
  );
  return evidence;
}

interface PendingEdge extends EvidenceSet {
  sourceSha: string;
  beforeSha: string;
  inputs: ReturnType<typeof inputEquivalence>;
}
export async function resolveFloor({
  oracle,
  sourceSha,
  collect,
  parent,
  equivalent,
  anchor,
}: {
  oracle: Oracle;
  sourceSha: string;
  collect: (sourceSha: string) => Promise<EvidenceSet>;
  parent: (sourceSha: string) => string;
  equivalent: (before: string, current: string) => ReturnType<typeof inputEquivalence>;
  anchor: () => Promise<MainFloor>;
}): Promise<MainFloor> {
  fullSha(sourceSha);
  const pending: PendingEdge[] = [];
  let current = sourceSha;
  for (let depth = 0; depth <= 32; depth++) {
    const found = await collect(current);
    let base: MainFloor | undefined;
    if (current === bootstrap.sourceSha) base = await anchor();
    else if (found.floors.length)
      base = accumulateFloor({
        oracle,
        sourceSha: current,
        predecessors: found.floors,
        scores: found.scores,
        evidence: found.evidence,
      });
    if (base) return finish(base, found, pending);
    if (depth === 32) throw new FloorPrerequisite("floor-gap-too-wide", sourceSha);
    const before = parent(current);
    const inputs = equivalent(before, current);
    if (!inputs.equivalent && !found.scores.length)
      throw new FloorPrerequisite("missing-non-equivalent-main-score", current);
    pending.push({ sourceSha: current, beforeSha: before, inputs, ...found });
    current = before;
  }
  throw new FloorPrerequisite("floor-gap-too-wide", sourceSha);
  function finish(base: MainFloor, found: EvidenceSet, pending: PendingEdge[]): MainFloor {
    let floor = accumulateFloor({
      oracle,
      sourceSha: base.sourceSha,
      predecessors: [base],
      scores: found.scores,
      evidence: base.evidence.concat(found.evidence),
    });
    for (const edge of pending.toReversed())
      floor = accumulateFloor({
        oracle,
        sourceSha: edge.sourceSha,
        predecessors: [floor].concat(edge.floors),
        scores: edge.scores,
        evidence: floor.evidence.concat(
          [
            {
              kind: edge.inputs.equivalent ? "equivalent-edge" : "scored-edge",
              beforeInputsSha256: edge.inputs.beforeInputsSha256,
              sourceInputsSha256: edge.inputs.sourceInputsSha256,
              sourceSha: edge.sourceSha,
              beforeSha: edge.beforeSha,
            },
          ],
          edge.evidence,
        ),
      });
    return floor;
  }
}
export async function resolveMainFloor({
  root,
  sourceSha,
  client,
}: {
  root: string;
  sourceSha: string;
  client: GithubClient;
}): Promise<{ oracle: Oracle; floor: MainFloor }> {
  const oracle = oracleAt(root, bootstrap.sourceSha);
  const { collect } = mainEvidence({ root, oracle, client });
  async function anchor(): Promise<MainFloor> {
    const run = await requestRun(client, `/actions/runs/${bootstrap.runId}/attempts/1`);
    assertMainRun(run, bootstrap.sourceSha, 1);
    const jobs = await requestJobs(
      client,
      `/actions/runs/${bootstrap.runId}/attempts/1/jobs?per_page=100`,
    );
    const producer = jobs.jobs.find((job) => job.id === bootstrap.jobId);
    assert.ok(
      producer &&
        producer.name === "own-shell-compatibility" &&
        producer.status === "completed" &&
        producer.conclusion === "success",
      "bootstrap producer prerequisite",
    );
    assert.equal(producer.run_id, bootstrap.runId);
    assert.equal(producer.run_attempt, bootstrap.attempt);
    assert.equal(producer.head_sha, bootstrap.sourceSha);
    const observed = successfulStep(producer, "Observe compatibility with the same-job node build");
    const uploaded = successfulStep(producer, "Run actions/upload-artifact@v4");
    assert.equal(observed.number, bootstrap.observationStep);
    assert.equal(uploaded.number, bootstrap.uploadStep);
    const artifact = await requestArtifact(client, `/actions/artifacts/${bootstrap.artifactId}`);
    assert.equal(artifact.name, "own-shell-current");
    assert.ok(artifact.workflow_run, "missing bootstrap artifact run");
    assert.equal(artifact.workflow_run.head_repository_id, authority.repositoryId);
    assert.equal(artifact.workflow_run.id, bootstrap.runId);
    assert.equal(artifact.workflow_run.head_sha, bootstrap.sourceSha);
    assert.equal(artifact.digest, `sha256:${bootstrap.archiveSha256}`);
    assert.equal(artifact.expired, false, "expired bootstrap prerequisite");
    const logs = await client.request(`/actions/jobs/${producer.id}/logs`, "text");
    assertUploadLog({ artifact, uploaded, logs, name: "own-shell-current" });
    const bytes = await client.request(`/actions/artifacts/${bootstrap.artifactId}/zip`, "bytes");
    const score = artifactJson(bytes, artifact, "own-shell-current.json", false);
    assertScore(score);
    return bootstrapFloor(oracle, bootstrap.sourceSha, score);
  }
  const floor = await resolveFloor({
    oracle,
    sourceSha,
    collect,
    parent: (sha) => firstParent(root, sha),
    equivalent: (a, b) => inputEquivalence(root, a, b),
    anchor,
  });
  return { oracle, floor };
}
