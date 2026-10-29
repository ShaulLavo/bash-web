import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import {
  accumulateFloor,
  bootstrap,
  bootstrapFloor,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.mjs";
import { bytesDigest, digest, verifyOracle } from "./shell-scoreboard.mjs";

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
class FloorPrerequisite extends Error {
  constructor(reason, sourceSha) {
    super(
      `scoreboard prerequisite: ${reason} for ${sourceSha}; retry the exact qualification/floor job after its evidence is available; no historical replay was started`,
    );
    this.name = "FloorPrerequisite";
    this.reason = reason;
    this.sourceSha = sourceSha;
  }
}
export function fullSha(value) {
  assert.equal(typeof value, "string", "missing source SHA");
  assert.match(value, /^[a-f0-9]{40}$/, "expected immutable full source SHA");
  return value;
}
function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0, "expected positive host ID/attempt");
  return value;
}
function gitBytes(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
export function git(root, args) {
  return gitBytes(root, args).toString("utf8").trimEnd();
}
export function assertAcceptedRecordCheckout(root, sourceSha) {
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
export function assertJobBinding(job, run) {
  assert.equal(job.run_id, run.id, "wrong job run");
  assert.equal(job.run_attempt, run.run_attempt, "wrong job attempt");
  assert.equal(job.head_sha, run.head_sha, "wrong job source");
}
export function assertLandedPullRequest(pr, { landed, original }) {
  assert.equal(pr.number, landed.pr);
  assert.equal(pr.merged, true, "unmerged record cannot certify candidate");
  assert.equal(pr.base.ref, "main");
  assert.equal(pr.base.repo.id, authority.repositoryId);
  assert.equal(pr.head.repo.id, authority.repositoryId);
  assert.equal(pr.head.sha, original.binding.headSha);
  assert.equal(pr.merge_commit_sha, landed.mergeCommit);
}
export function assertObservationSequence(raw, bound, observed, sealed) {
  assert.ok(
    Date.parse(observed.started_at) >= Date.parse(bound.completed_at) &&
      Date.parse(observed.completed_at) > Date.parse(raw.capturedAt) &&
      Date.parse(observed.completed_at) <= Date.parse(sealed.started_at),
    "stale Waffle observation",
  );
}
export function oracleAt(root, sourceSha) {
  fullSha(sourceSha);
  const bytes = gitBytes(root, ["show", `${sourceSha}:docs/evidence/own-shell-oracle.json`]);
  const pins = JSON.parse(git(root, ["show", `${sourceSha}:sources.lock.json`]));
  assert.equal(
    bytesDigest(bytes),
    pins.shellScoreboard.oracleSha256,
    "trusted source oracle checksum",
  );
  const oracle = JSON.parse(bytes.toString("utf8"));
  verifyOracle(oracle);
  return oracle;
}
function documentation(path) {
  return path === "README.md" || path === "AGENTS.md" || /^docs\/.+\.md$/.test(path);
}
export function scoringInputs(root, sourceSha) {
  fullSha(sourceSha);
  const records = git(root, ["ls-tree", "-r", "-z", sourceSha]).split("\0").filter(Boolean);
  return records.filter((record) => {
    const path = record.slice(record.indexOf("\t") + 1);
    return !record.startsWith("100644 blob ") || !documentation(path);
  });
}
function inputEquivalence(root, left, right) {
  const beforeInputsSha256 = digest(scoringInputs(root, left));
  const sourceInputsSha256 = digest(scoringInputs(root, right));
  return {
    equivalent: beforeInputsSha256 === sourceInputsSha256,
    beforeInputsSha256,
    sourceInputsSha256,
  };
}
export function sourceEquivalent(root, left, right) {
  return inputEquivalence(root, left, right).equivalent;
}
export function firstParent(root, sourceSha) {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", fullSha(sourceSha)]).split(" ");
  assert.equal(parents[0], sourceSha);
  if (!parents[1]) throw new FloorPrerequisite("missing-main-predecessor", sourceSha);
  return fullSha(parents[1]);
}
export function assertMainRun(run, sourceSha, attempt) {
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
function successfulStep(job, name) {
  const selected = job.steps.filter((step) => step.name === name);
  assert.equal(selected.length, 1, `missing/ambiguous producer step ${name}`);
  const step = selected[0];
  assert.equal(step.status, "completed", `unfinished ${name}`);
  assert.equal(step.conclusion, "success", `unsuccessful ${name}`);
  assert.ok(
    Number.isFinite(Date.parse(step.started_at)) && Number.isFinite(Date.parse(step.completed_at)),
    "missing host step times",
  );
  return step;
}
function assertJobIdentity(job, run) {
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
}) {
  const contract = contracts[kind];
  assert.ok(contract, "unknown artifact kind");
  assert.equal(job.name, contract.job, "wrong producer job");
  assert.equal(job.run_id, run.id, "wrong producer run");
  assert.equal(job.run_attempt, run.run_attempt, "old producer attempt");
  assert.equal(job.head_sha, run.head_sha, "wrong producer source");
  assert.equal(job.status, "completed", "unfinished producer");
  assert.ok(
    kind === "floor"
      ? ["success", "failure"].includes(job.conclusion)
      : job.conclusion === "success",
    "cancelled/failed raw producer",
  );
  positive(job.id);
  const observed = successfulStep(job, contract.observe);
  const uploaded = successfulStep(job, contract.upload);
  assert.ok(observed.number < uploaded.number, "upload must follow complete observation");
  for (const step of job.steps) {
    if (["success", "skipped"].includes(step.conclusion)) continue;
    assert.ok(
      kind === "floor" && step.name === "Enforce qualification" && step.conclusion === "failure",
      "unexpected failed producer step",
    );
  }
  const definition = parse(workflow);
  const expression = `${contract.prefix}-\${{ github.sha }}-\${{ github.run_id }}-\${{ github.run_attempt }}`;
  const uploaders = Object.entries(definition.jobs).flatMap(([owner, value]) =>
    (value.steps ?? [])
      .filter(
        (step) => step.uses === "actions/upload-artifact@v4" && step.with?.name === expression,
      )
      .map((step) => ({ owner, step })),
  );
  assert.equal(uploaders.length, 1, "reviewed workflow must have one unique uploader expression");
  const uploader = uploaders[0];
  assert.equal(uploader.owner, contract.job, "wrong reviewed uploader owner");
  if (contract.uploadId) {
    assert.equal(uploader.step.id, contract.uploadId, "wrong reviewed upload step ID");
    assert.equal(uploader.step.name, undefined, "observation upload step must be unnamed");
  } else assert.equal(uploader.step.name, contract.upload, "wrong reviewed upload step");
  assert.equal(
    uploader.step.with["if-no-files-found"],
    contract.optionalFile ? "ignore" : "error",
    contract.optionalFile
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

function assertUploadLog({ artifact, uploaded, logs, name }) {
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
export function artifactJson(bytes, artifact, member, exact = true) {
  assert.ok(bytes.byteLength <= 16 * 1024 * 1024, "artifact archive too large");
  assert.equal(`sha256:${bytesDigest(bytes)}`, artifact.digest, "archive digest mismatch");
  return JSON.parse(
    execFileSync("python3", ["-c", unzipJson, member, exact ? "exact" : "bootstrap"], {
      input: bytes,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}
export function githubClient(token) {
  assert.ok(token, "missing read-only workflow token");
  const cache = new Map();
  async function fetchResponse(path, type) {
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
    return JSON.parse(bytes.toString("utf8"));
  }
  function request(path, type = "json") {
    const key = `${type}:${path}`;
    if (!cache.has(key)) cache.set(key, fetchResponse(path, type));
    return cache.get(key);
  }
  return { request };
}
export function mainEvidence({ root, oracle, client }) {
  const cache = new Map();
  async function collect(sourceSha) {
    if (cache.has(sourceSha)) return cache.get(sourceSha);
    const listing = await client.request(
      `/actions/workflows/${authority.workflowId}/runs?event=push&head_sha=${fullSha(sourceSha)}&per_page=100`,
    );
    if (listing.total_count > 100) throw new FloorPrerequisite("too-many-source-runs", sourceSha);
    const result = { floors: [], scores: [], evidence: [] };
    for (const run of listing.workflow_runs) await collectRun(run, sourceSha, result);
    cache.set(sourceSha, result);
    return result;
  }
  async function collectRun(summary, sourceSha, result) {
    if (summary.run_attempt > 32)
      throw new FloorPrerequisite("too-many-source-attempts", sourceSha);
    const artifacts = await client.request(
      `/actions/runs/${positive(summary.id)}/artifacts?per_page=100`,
    );
    if (artifacts.total_count > 100)
      throw new FloorPrerequisite("too-many-run-artifacts", sourceSha);
    for (let attempt = 1; attempt <= summary.run_attempt; attempt++)
      await collectAttempt(summary.id, attempt, sourceSha, artifacts.artifacts, result);
  }
  async function collectAttempt(runId, attempt, sourceSha, artifacts, result) {
    const run = await client.request(`/actions/runs/${runId}/attempts/${attempt}`);
    assertMainRun(run, sourceSha, attempt);
    assert.equal(run.id, runId, "host run ID mismatch");
    const jobs = await client.request(
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    );
    assert.ok(jobs.total_count <= 100, "too many producer jobs");
    const scores = result.scores.length;
    for (const kind of ["raw", "floor"])
      await collectArtifact(run, jobs.jobs, artifacts, kind, result);
    if (result.scores.length === scores)
      await collectObservation(run, jobs.jobs, artifacts, result);
  }
  async function collectArtifact(run, jobs, artifacts, kind, result) {
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
    assert.equal(value.sourceSha, run.head_sha, "payload source mismatch");
    assert.deepEqual(
      value.run,
      { runId: run.id, attempt: run.run_attempt },
      "payload attempt mismatch",
    );
    if (kind === "floor") result.floors.push(validateFloor(oracle, value));
    else admitRaw(value, run.head_sha, result);
    result.evidence.push({
      kind,
      sourceSha: run.head_sha,
      ...evidence,
      payloadSha256: digest(value),
    });
  }
  async function collectObservation(run, jobs, artifacts, result) {
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
    const beforeSha = fullSha(input.selected?.beforeSha);
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
    const capturedAt = Date.parse(input.capturedAt);
    assert.ok(
      capturedAt >= Date.parse(bind.started_at) &&
        capturedAt < Date.parse(bind.completed_at) + 1000,
      "observation capture outside bind step",
    );
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
  function admitRaw(value, sourceSha, result) {
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

export async function admitQualificationRaw({ root, client, raw }) {
  const run = await client.request(
    `/actions/runs/${positive(raw.run.runId)}/attempts/${positive(raw.run.attempt)}`,
  );
  assert.equal(run.id, raw.run.runId, "host raw run ID mismatch");
  assert.equal(run.repository?.id, authority.repositoryId);
  if (raw.selected.kind === "main-push")
    assert.equal(run.head_repository?.id, authority.repositoryId);
  assert.equal(run.workflow_id, authority.workflowId);
  assert.equal(run.path, authority.workflowPath);
  assert.equal(
    run.head_sha,
    raw.selected.kind === "pull-request" ? raw.selected.headSha : raw.sourceSha,
  );
  assert.equal(run.event, raw.selected.kind === "pull-request" ? "pull_request" : "push");
  assert.equal(run.run_attempt, raw.run.attempt);
  if (run.event === "push") assertMainRun(run, raw.sourceSha, raw.run.attempt);
  const jobs = await client.request(
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  assert.ok(jobs.total_count <= 100);
  const producers = jobs.jobs.filter((job) => job.name === contracts.raw.job);
  assert.equal(producers.length, 1, "missing unique raw producer");
  const listing = await client.request(`/actions/runs/${run.id}/artifacts?per_page=100`);
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

export async function resolveFloor({ oracle, sourceSha, collect, parent, equivalent, anchor }) {
  fullSha(sourceSha);
  const pending = [];
  let current = sourceSha;
  for (let depth = 0; depth <= 32; depth++) {
    const found = await collect(current);
    let base;
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
  function finish(base, found, pending) {
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
export async function resolveMainFloor({ root, sourceSha, client }) {
  const oracle = oracleAt(root, bootstrap.sourceSha);
  const { collect } = mainEvidence({ root, oracle, client });
  async function anchor() {
    const run = await client.request(`/actions/runs/${bootstrap.runId}/attempts/1`);
    assertMainRun(run, bootstrap.sourceSha, 1);
    const jobs = await client.request(
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
    const artifact = await client.request(`/actions/artifacts/${bootstrap.artifactId}`);
    assert.equal(artifact.name, "own-shell-current");
    assert.equal(artifact.workflow_run.head_repository_id, authority.repositoryId);
    assert.equal(artifact.workflow_run.id, bootstrap.runId);
    assert.equal(artifact.workflow_run.head_sha, bootstrap.sourceSha);
    assert.equal(artifact.digest, `sha256:${bootstrap.archiveSha256}`);
    assert.equal(artifact.expired, false, "expired bootstrap prerequisite");
    const logs = await client.request(`/actions/jobs/${producer.id}/logs`, "text");
    assertUploadLog({ artifact, uploaded, logs, name: "own-shell-current" });
    const bytes = await client.request(`/actions/artifacts/${bootstrap.artifactId}/zip`, "bytes");
    return bootstrapFloor(
      oracle,
      bootstrap.sourceSha,
      artifactJson(bytes, artifact, "own-shell-current.json", false),
    );
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
