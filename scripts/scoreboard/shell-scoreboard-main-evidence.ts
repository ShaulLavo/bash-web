import assert from "node:assert/strict";
import {
  assertMainFloor,
  bootstrap,
  bootstrapFloor,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.ts";
import type { MainFloor } from "./shell-scoreboard-floor.ts";
import { assertScore, digest } from "./shell-scoreboard.ts";
import type { Oracle } from "./shell-scoreboard.ts";
import {
  artifactJson,
  assertJobIdentity,
  assertMainRun,
  assertRawScore,
  assertUploadLog,
  assertUploader,
  authority,
  contracts,
  firstParent,
  FloorPrerequisite,
  fullSha,
  git,
  inputEquivalence,
  oracleAt,
  positive,
  readObservationArchive,
  requestArtifact,
  requestArtifacts,
  requestJobs,
  requestRun,
  requestWorkflowRuns,
  resolveFloor,
  scoringInputs,
  successfulStep,
} from "./shell-scoreboard-main.ts";
import type {
  EvidenceSet,
  GithubClient,
  HostArtifact,
  HostJob,
  HostRun,
  HostRunSummary,
  RawScore,
} from "./shell-scoreboard-main.ts";
import { collectMainDispatches } from "./shell-scoreboard-main-dispatch-evidence.ts";

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
    assert.equal(
      listing.workflow_runs.length,
      listing.total_count,
      "scoreboard prerequisite: incomplete main push discovery",
    );
    const result: EvidenceSet = { floors: [], scores: [], evidence: [] };
    for (const run of listing.workflow_runs) await collectRun(run, sourceSha, result);
    await collectMainDispatches({ root, oracle, client, sourceSha, result });
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
    const job = observations[0];
    const archive = await readObservationArchive({
      root,
      client,
      run,
      job,
      artifact,
      sourceSha: run.head_sha,
    });
    validateOwnScore(oracle, archive.score);
    result.scores.push(archive.score);
    result.evidence.push({
      kind: "observation",
      sourceSha: run.head_sha,
      ...archive.evidence,
      inputSha256: digest(archive.input),
      payloadSha256: digest(archive.score),
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
