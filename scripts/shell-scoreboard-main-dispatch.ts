import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  accumulateFloor,
  assertMainFloor,
  bootstrap,
  correctFalsePasses,
  qualification,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.ts";
import type { MainFloor } from "./shell-scoreboard-floor.ts";
import {
  artifactJson,
  assertUploader,
  authority,
  firstParent,
  fullSha,
  git,
  githubClient,
  mainEvidence,
  oracleAt,
  requestArtifacts,
  requestJobs,
  requestRun,
  requestWorkflowRuns,
  resolveMainFloor,
  scoringInputs,
} from "./shell-scoreboard-main.ts";
import type { EvidenceSet, GithubClient, HostRun } from "./shell-scoreboard-main.ts";
import {
  assertBinding,
  assertRecord,
  assertRunBinding,
  assertScore,
  digest,
} from "./shell-scoreboard.ts";
import type { MainDispatchBinding, Oracle, RunBinding, Score } from "./shell-scoreboard.ts";

const controllerPaths = [
  ".github/workflows/ci.yml",
  ".github/actions/wasi-sdk/action.yml",
  "package.json",
  "package-lock.json",
  "scripts/shell-scoreboard.ts",
  "scripts/shell-scoreboard-floor.ts",
  "scripts/shell-scoreboard-main.ts",
  "scripts/shell-scoreboard-main-dispatch.ts",
];
interface PreparedMain {
  selected: MainDispatchBinding;
  run: RunBinding;
  capturedAt: string;
  observedMainSha: string;
  inputsSha256: string;
  floor: MainFloor;
}
interface MainRaw extends PreparedMain {
  schema: 1;
  kind: "main-dispatch-score";
  resultSha256: string;
  score: Score;
}
export function mainDispatchTitle(sourceSha: string): string {
  return `Qualify main ${fullSha(sourceSha)}`;
}
export function controllerInputs(root: string, sourceSha: string): string[] {
  const entries = git(root, ["ls-tree", "-r", fullSha(sourceSha), "--"].concat(controllerPaths))
    .split("\n")
    .filter(Boolean);
  assert.equal(entries.length, controllerPaths.length, "incomplete controller closure");
  for (const entry of entries) assert.match(entry, /^100644 blob [a-f0-9]{40}\t/);
  return entries;
}
export function assertControllerTrust(root: string, selected: MainDispatchBinding): void {
  assert.equal(
    git(root, ["diff", "--name-only", "HEAD", "--"].concat(controllerPaths)),
    "",
    "modified consumer controller",
  );
  const executor = controllerInputs(root, selected.executorSha);
  assert.equal(digest(executor), selected.controllerSha256, "executor controller digest mismatch");
  assert.deepEqual(
    executor,
    controllerInputs(root, git(root, ["rev-parse", "HEAD"])),
    "executor differs from trusted consumer controller",
  );
}
export function assertMainDispatchRun(
  root: string,
  run: HostRun,
  selected: MainDispatchBinding,
  attempt: number,
): void {
  assert.equal(run.repository?.id, authority.repositoryId, "wrong main dispatch repository");
  assert.equal(
    run.head_repository.id,
    authority.repositoryId,
    "wrong main dispatch head repository",
  );
  assert.equal(run.workflow_id, authority.workflowId, "wrong main dispatch workflow");
  assert.equal(run.path, authority.workflowPath, "wrong main dispatch workflow path");
  assert.equal(run.event, "workflow_dispatch", "wrong main dispatch event");
  assert.equal(
    run.display_title,
    mainDispatchTitle(selected.sourceSha),
    "wrong main dispatch title",
  );
  assert.equal(run.head_sha, fullSha(selected.executorSha), "wrong main dispatch executor");
  assert.equal(selected.executorRef, `refs/heads/${run.head_branch}`, "wrong main dispatch ref");
  assert.match(selected.executorRef, /^refs\/heads\/.+/);
  assert.equal(run.run_attempt, attempt, "wrong main dispatch attempt");
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 32);
  assert.equal(firstParent(root, selected.sourceSha), selected.beforeSha, "wrong main predecessor");
  assertControllerTrust(root, selected);
}
async function currentMain(root: string, client: GithubClient): Promise<string> {
  const main = await client.request("/git/ref/heads/main");
  assertRecord(main);
  assertRecord(main.object);
  const source = fullSha(main.object.sha);
  git(root, ["fetch", "--no-tags", "origin", source]);
  return source;
}
async function assertMainAncestry(
  root: string,
  client: GithubClient,
  sourceSha: string,
): Promise<void> {
  const main = await currentMain(root, client);
  assert.ok(
    git(root, ["rev-list", "--first-parent", main]).split("\n").includes(sourceSha),
    "measured source is not in main history",
  );
}
function assertPrepared(value: unknown): asserts value is PreparedMain {
  assertRecord(value);
  assertBinding(value.selected);
  assert.equal(value.selected.kind, "main-dispatch");
  assertRunBinding(value.run);
  assert.equal(value.observedMainSha, value.selected.sourceSha, "main was not captured exactly");
  assert.ok(typeof value.capturedAt === "string");
  assert.ok(Number.isFinite(Date.parse(value.capturedAt)));
  assert.equal(typeof value.inputsSha256, "string");
  assertMainFloor(value.floor);
  assert.equal(value.floor.sourceSha, value.selected.beforeSha, "wrong captured predecessor floor");
}
function assertRaw(value: unknown): asserts value is MainRaw {
  assertPrepared(value);
  assertRecord(value);
  assert.equal(value.schema, 1);
  assert.equal(value.kind, "main-dispatch-score");
  assertScore(value.score);
  assert.equal(value.resultSha256, digest(value.score), "main raw result digest mismatch");
}
function assertMeasured(root: string, sourceSha: string): void {
  assert.equal(git(root, ["rev-parse", "HEAD"]), fullSha(sourceSha), "wrong measured checkout");
  assert.equal(git(root, ["diff", "--name-only", sourceSha, "--"]), "", "modified measured source");
}
function assertRawIdentity(root: string, oracle: Oracle, raw: MainRaw): void {
  assert.equal(raw.inputsSha256, digest(scoringInputs(root, raw.selected.sourceSha)));
  validateFloor(oracle, raw.floor);
  validateOwnScore(oracle, raw.score);
}
interface Context {
  root: string;
  client: GithubClient;
}
export async function prepareMainDispatch({
  root,
  measuredRoot,
  client,
  sourceSha,
  executorRef,
  run: binding,
}: Context & {
  measuredRoot: string;
  sourceSha: string;
  executorRef: string;
  run: RunBinding;
}): Promise<PreparedMain> {
  const observedMainSha = await currentMain(root, client);
  assert.equal(
    fullSha(sourceSha),
    observedMainSha,
    "qualification must capture exact current main",
  );
  assertMeasured(measuredRoot, sourceSha);
  const executorSha = git(root, ["rev-parse", "HEAD"]);
  const selected: MainDispatchBinding = {
    kind: "main-dispatch",
    sourceSha,
    beforeSha: firstParent(root, sourceSha),
    executorSha,
    executorRef,
    controllerSha256: digest(controllerInputs(root, executorSha)),
  };
  const run = await requestRun(
    client,
    `/actions/runs/${binding.runId}/attempts/${binding.attempt}`,
  );
  assert.equal(run.id, binding.runId);
  assertMainDispatchRun(root, run, selected, binding.attempt);
  const oracle = oracleAt(root, bootstrap.sourceSha);
  assert.deepEqual(oracleAt(root, sourceSha).identity, oracle.identity, "changed frozen oracle");
  const previous = await resolveMainFloor({ root, sourceSha: selected.beforeSha, client });
  return {
    selected,
    run: binding,
    observedMainSha,
    capturedAt: new Date().toISOString(),
    inputsSha256: digest(scoringInputs(root, sourceSha)),
    floor: correctFalsePasses(oracle, previous.floor),
  };
}
export function sealMainDispatch({
  root,
  measuredRoot,
  prepared,
  score,
}: {
  root: string;
  measuredRoot: string;
  prepared: unknown;
  score: unknown;
}): MainRaw {
  assertPrepared(prepared);
  assertMeasured(measuredRoot, prepared.selected.sourceSha);
  assertControllerTrust(root, prepared.selected);
  assertScore(score);
  const raw: MainRaw = {
    ...prepared,
    schema: 1,
    kind: "main-dispatch-score",
    resultSha256: digest(score),
    score,
  };
  assertRawIdentity(root, oracleAt(root, bootstrap.sourceSha), raw);
  return raw;
}
export async function foldMainDispatch({ root, client, raw: input }: Context & { raw: unknown }) {
  assertRaw(input);
  const raw = input;
  const { selected } = raw;
  const run = await requestRun(
    client,
    `/actions/runs/${raw.run.runId}/attempts/${raw.run.attempt}`,
  );
  assert.equal(run.id, raw.run.runId);
  assertMainDispatchRun(root, run, selected, raw.run.attempt);
  await assertMainAncestry(root, client, selected.sourceSha);
  const oracle = oracleAt(root, bootstrap.sourceSha);
  assertRawIdentity(root, oracle, raw);
  const previous = await resolveMainFloor({ root, sourceSha: selected.beforeSha, client });
  const current = await mainEvidence({ root, oracle, client }).collect(selected.sourceSha);
  const floor = accumulateFloor({
    oracle,
    sourceSha: selected.sourceSha,
    predecessors: [correctFalsePasses(oracle, previous.floor), raw.floor].concat(current.floors),
    scores: current.scores.concat([raw.score]),
    evidence: previous.floor.evidence.concat(current.evidence),
  });
  const result = qualification(oracle, floor, raw.score, selected);
  assert.equal(result.ok, true, "required main passes were lost; no floor published");
  return {
    floor: {
      ...floor,
      run: raw.run,
      beforeSha: selected.beforeSha,
      dispatch: selected,
      lostIds: [],
    },
    qualification: result,
  };
}
export async function collectMainDispatches({
  root,
  oracle,
  client,
  sourceSha,
  result,
}: Context & { oracle: Oracle; sourceSha: string; result: EvidenceSet }): Promise<void> {
  const seen = new Set<number>();
  for (let page = 1; page <= 32; page++) {
    const listing = await requestWorkflowRuns(
      client,
      `/actions/workflows/${authority.workflowId}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
    );
    assert.ok(
      listing.total_count <= 3200,
      "scoreboard prerequisite: main dispatch discovery exhausted",
    );
    assert.equal(
      listing.workflow_runs.length,
      Math.min(100, Math.max(0, listing.total_count - (page - 1) * 100)),
      "scoreboard prerequisite: incomplete main dispatch discovery",
    );
    for (const summary of listing.workflow_runs) {
      assert.ok(!seen.has(summary.id), "scoreboard prerequisite: unstable main dispatch discovery");
      seen.add(summary.id);
      if (summary.display_title !== mainDispatchTitle(sourceSha)) continue;
      assert.ok(
        summary.run_attempt <= 32,
        "scoreboard prerequisite: too many main dispatch attempts",
      );
      await collectDispatchRun({
        root,
        oracle,
        client,
        sourceSha,
        result,
        runId: summary.id,
        attempts: summary.run_attempt,
      });
    }
    if (listing.total_count <= page * 100) return;
  }
  throw new Error("scoreboard prerequisite: main dispatch discovery exhausted");
}
async function collectDispatchRun(
  input: Context & {
    oracle: Oracle;
    sourceSha: string;
    result: EvidenceSet;
    runId: number;
    attempts: number;
  },
): Promise<void> {
  for (let attempt = 1; attempt <= input.attempts; attempt++)
    await collectDispatchAttempt({ ...input, attempt });
}
async function collectDispatchAttempt({
  root,
  oracle,
  client,
  sourceSha,
  result,
  runId,
  attempt,
}: Context & {
  oracle: Oracle;
  sourceSha: string;
  result: EvidenceSet;
  runId: number;
  attempt: number;
}): Promise<void> {
  const run = await requestRun(client, `/actions/runs/${runId}/attempts/${attempt}`);
  assert.equal(run.id, runId);
  if (run.status !== "completed" || run.conclusion !== "success") return;
  const jobs = await requestJobs(
    client,
    `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
  );
  assert.ok(jobs.total_count <= 100);
  const producers = jobs.jobs.filter((job) => job.name === "main-qualification");
  if (!producers.length || producers[0].conclusion === "skipped") return;
  assert.equal(producers.length, 1, "ambiguous main qualification producer");
  const gates = jobs.jobs.filter((job) => job.name === "shell");
  assert.equal(gates.length, 1, "missing main dispatch aggregate");
  assert.equal(gates[0].status, "completed");
  assert.equal(gates[0].conclusion, "success", "failed main dispatch aggregate");
  assert.equal(gates[0].run_id, runId);
  assert.equal(gates[0].run_attempt, attempt);
  assert.equal(gates[0].head_sha, run.head_sha);
  const listing = await requestArtifacts(client, `/actions/runs/${runId}/artifacts?per_page=100`);
  assert.ok(listing.total_count <= 100);
  const executorSha = fullSha(run.head_sha);
  try {
    git(root, ["rev-parse", "--verify", `${executorSha}^{commit}`]);
  } catch {
    git(root, ["fetch", "--no-tags", "origin", executorSha]);
  }
  const workflow = git(root, ["show", `${executorSha}:${authority.workflowPath}`]);
  const logs = await client.request(`/actions/jobs/${producers[0].id}/logs`, "text");
  const admitted = [];
  for (const kind of ["main-raw", "main-floor"] as const) {
    const matches = listing.artifacts.filter(
      (artifact) => artifact.name === `own-shell-${kind}-${sourceSha}-${runId}-${attempt}`,
    );
    assert.equal(matches.length, 1, "missing/ambiguous main dispatch artifact");
    const artifact = matches[0];
    const evidence = assertUploader({
      run,
      job: producers[0],
      artifact,
      kind,
      workflow,
      logs,
      testedSource: sourceSha,
    });
    const bytes = await client.request(`/actions/artifacts/${artifact.id}/zip`, "bytes");
    const value = artifactJson(bytes, artifact, kind === "main-raw" ? "raw.json" : "floor.json");
    admitted.push({ value, evidence });
  }
  const raw = admitted[0].value;
  assertRaw(raw);
  const selected = raw.selected;
  assert.equal(selected.sourceSha, sourceSha, "wrong measured artifact source");
  assert.deepEqual(raw.run, { runId, attempt }, "wrong measured artifact attempt");
  assertMainDispatchRun(root, run, selected, attempt);
  await assertMainAncestry(root, client, sourceSha);
  assertRawIdentity(root, oracle, raw);
  assertDispatchSequence(raw, producers[0].steps);
  const floor = admitted[1].value;
  assertMainFloor(floor);
  assert.deepEqual(floor.dispatch, selected, "wrong main floor binding");
  assert.equal(floor.sourceSha, sourceSha);
  assert.equal(floor.beforeSha, selected.beforeSha);
  assert.deepEqual(floor.run, raw.run);
  assert.deepEqual(floor.lostIds, []);
  validateFloor(oracle, floor);
  const union = accumulateFloor({
    oracle,
    sourceSha,
    predecessors: [raw.floor, floor],
    scores: [raw.score],
  });
  assert.equal(
    union.floorSha256,
    floor.floorSha256,
    "dispatch floor dropped observed requirements",
  );
  assert.equal(
    qualification(oracle, floor, raw.score, selected).ok,
    true,
    "dispatch lost main passes",
  );
  result.scores.push(raw.score);
  result.floors.push(floor);
  result.evidence.push(
    ...admitted.map(({ value, evidence }) => ({
      kind: "main-dispatch",
      sourceSha,
      executorSha: selected.executorSha,
      controllerSha256: selected.controllerSha256,
      ...evidence,
      payloadSha256: digest(value),
    })),
  );
}
function assertDispatchSequence(
  raw: MainRaw,
  steps: {
    name: string;
    started_at: string | null;
    completed_at: string | null;
    number: number;
    conclusion: string | null;
  }[],
): void {
  const names = [
    "Bind exact main source",
    "Observe unchanged main source",
    "Seal exact main raw score",
    "Upload exact main raw score",
    "Fold exact main floor",
    "Upload exact main floor",
  ];
  const ordered = names.map((name) => {
    const matches = steps.filter((step) => step.name === name);
    assert.equal(matches.length, 1, `missing/ambiguous main step ${name}`);
    const step = matches[0];
    assert.equal(step.conclusion, "success");
    assert.ok(step.started_at && step.completed_at, "missing main step times");
    return {
      number: step.number,
      start: Date.parse(step.started_at),
      end: Date.parse(step.completed_at),
    };
  });
  assert.ok(ordered.every((step) => Number.isFinite(step.start) && step.start <= step.end));
  assert.ok(
    Date.parse(raw.capturedAt) >= ordered[0].start &&
      Date.parse(raw.capturedAt) < ordered[0].end + 1000,
  );
  for (let index = 1; index < ordered.length; index++) {
    assert.ok(ordered[index - 1].number < ordered[index].number);
    assert.ok(ordered[index - 1].end <= ordered[index].start, "out-of-order main observation");
  }
}
function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function assertEnvironment(prepared: PreparedMain): void {
  assert.equal(prepared.run.runId, Number(process.env.GITHUB_RUN_ID));
  assert.equal(prepared.run.attempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(prepared.selected.executorSha, process.env.GITHUB_SHA);
  assert.equal(prepared.selected.executorRef, process.env.GITHUB_REF);
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
}
async function main(): Promise<void> {
  const [command, measuredRoot, directory] = process.argv.slice(2);
  assert.ok(measuredRoot && directory, "requires measured checkout and output directory");
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(directory, { recursive: true });
  if (command === "seal") {
    const prepared = read(resolve(directory, "input.json"));
    assertPrepared(prepared);
    assertEnvironment(prepared);
    write(
      resolve(directory, "raw.json"),
      sealMainDispatch({
        root,
        measuredRoot,
        prepared,
        score: read(resolve(directory, "score.json")),
      }),
    );
    return;
  }
  const client = githubClient(process.env.GH_TOKEN);
  if (command === "prepare") {
    const event = read(process.env.GITHUB_EVENT_PATH ?? "");
    assertRecord(event);
    assertRecord(event.inputs);
    assert.equal(
      event.repository &&
        typeof event.repository === "object" &&
        "id" in event.repository &&
        event.repository.id,
      authority.repositoryId,
    );
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(git(root, ["rev-parse", "HEAD"]), fullSha(process.env.GITHUB_SHA));
    const prepared = await prepareMainDispatch({
      root,
      measuredRoot,
      client,
      sourceSha: fullSha(event.inputs.main_source),
      executorRef: process.env.GITHUB_REF ?? "",
      run: {
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
    });
    write(resolve(directory, "input.json"), prepared);
    return;
  }
  assert.equal(command, "fold");
  const raw = read(resolve(directory, "raw.json"));
  assertRaw(raw);
  assertEnvironment(raw);
  assertMeasured(measuredRoot, raw.selected.sourceSha);
  const folded = await foldMainDispatch({ root, client, raw });
  write(resolve(directory, "qualification.json"), folded.qualification);
  write(resolve(directory, "floor.json"), folded.floor);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error("Exact main qualification failed:", error);
    process.exitCode = 1;
  });
}
