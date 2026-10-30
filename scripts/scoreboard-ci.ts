import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  accumulateFloor,
  assertMainFloor,
  bootstrap,
  qualification,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.ts";
import type { FloorEvidence, MainFloor, Qualification } from "./shell-scoreboard-floor.ts";
import {
  admitQualificationRaw,
  authority,
  fullSha,
  git,
  githubClient,
  mainEvidence,
  oracleAt,
  requestRun,
  resolveMainFloor,
  scoringInputs,
  sourceEquivalent,
} from "./shell-scoreboard-main.ts";
import type { GithubClient, HostRun, RawScore } from "./shell-scoreboard-main.ts";
import {
  assertBinding,
  assertRecord,
  assertRunBinding,
  assertScore,
  digest,
} from "./shell-scoreboard.ts";
import type { Binding, MainPushBinding, Oracle, RunBinding } from "./shell-scoreboard.ts";
import {
  assertAcceptedFloor,
  assertAcceptedRaw,
  assertRawIdentity,
  prepareCandidate,
  foldCandidate,
} from "./shell-scoreboard-accepted-gains.ts";
import type { AcceptedGainFloor } from "./shell-scoreboard-accepted-gains.ts";
import { terminalRecoveryTarget } from "./shell-scoreboard-terminal-recovery.ts";

interface PullRequestEvent {
  head: { sha: string };
  base: { sha: string; ref: string; repo: { id: number } };
}
interface GitHubEvent {
  repository?: { id: number };
  ref?: string;
  after?: string;
  before?: string;
  pull_request?: PullRequestEvent;
  [key: string]: unknown;
}
interface PullRequestTargetBinding {
  kind: "pull-request";
  headSha: string;
  testedMergeSha: string;
  baseSha: string;
}
interface QualificationInput {
  root: string;
  event: GitHubEvent;
  eventName: string | undefined;
  sourceSha: string;
  mainSha?: string;
}
type QualificationRaw = RawScore<MainFloor | AcceptedGainFloor | null> & {
  floor: MainFloor | AcceptedGainFloor | null;
  capturedAt: string;
};
interface PreparedQualification {
  selected: Binding;
  run: RunBinding;
  observedMainAfter: string | null;
  sourceSha: string;
  capturedAt: string;
  floor: MainFloor | AcceptedGainFloor | null;
  inputsSha256: string;
  [key: string]: unknown;
}
interface BoundQualification {
  selected: Binding;
  run: RunBinding;
  observedMainAfter: string | null;
}
function assertEvent(value: unknown): asserts value is GitHubEvent {
  assertRecord(value);
  if (value.repository !== undefined) {
    assertRecord(value.repository);
    assert.equal(typeof value.repository.id, "number", "invalid event repository");
  }
  if (value.pull_request === undefined) return;
  assertRecord(value.pull_request);
  assertRecord(value.pull_request.head);
  assert.equal(typeof value.pull_request.head.sha, "string", "invalid event head");
  assertRecord(value.pull_request.base);
  assert.equal(typeof value.pull_request.base.sha, "string", "invalid event base");
  assert.equal(typeof value.pull_request.base.ref, "string", "invalid event base ref");
  assertRecord(value.pull_request.base.repo);
  assert.equal(typeof value.pull_request.base.repo.id, "number", "invalid event base repository");
}
function assertQualificationRaw(value: unknown): asserts value is QualificationRaw {
  assertRawIdentity(value);
  if (value.floor === null) return;
  assertRecord(value.floor);
  if (value.floor.kind === "AcceptedGainFloor") {
    assertAcceptedRaw(value);
    return;
  }
  assertMainFloor(value.floor);
}
function assertPrepared(value: unknown): asserts value is PreparedQualification {
  assertRecord(value);
  assertBinding(value.selected);
  assertRunBinding(value.run);
  fullSha(value.sourceSha);
  assert.equal(typeof value.capturedAt, "string", "missing preparation capture time");
  assert.equal(typeof value.inputsSha256, "string", "missing preparation input digest");
  assert.ok(value.observedMainAfter === null || typeof value.observedMainAfter === "string");
  if (value.floor === null) return;
  assertRecord(value.floor);
  if (value.floor.kind === "AcceptedGainFloor") {
    assertAcceptedFloor(value.floor);
    return;
  }
  assertMainFloor(value.floor);
}
function json(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return value;
}
function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function envPath(name: string): string {
  const value = process.env[name];
  assert.ok(value, `missing ${name}`);
  return value;
}
function targetBinding({
  root,
  event,
  eventName,
  sourceSha,
}: QualificationInput): MainPushBinding | PullRequestTargetBinding {
  assert.equal(event.repository?.id, authority.repositoryId, "wrong event repository");
  assert.equal(
    git(root, ["rev-parse", "HEAD"]),
    fullSha(sourceSha),
    "checkout does not match tested source",
  );
  if (eventName === "push") {
    assert.equal(event.ref, "refs/heads/main", "only main pushes qualify");
    assert.equal(event.after, sourceSha, "wrong pushed source");
    const beforeSha = fullSha(event.before);
    assert.equal(
      git(root, ["merge-base", beforeSha, sourceSha]),
      beforeSha,
      "push predecessor not in tested main",
    );
    return { kind: "main-push", sourceSha, beforeSha };
  }
  assert.equal(eventName, "pull_request", "unsupported qualification event");
  const pull = event.pull_request;
  assert.ok(pull, "missing pull request event");
  const headSha = fullSha(pull.head.sha);
  const eventBaseSha = fullSha(pull.base.sha);
  assert.equal(pull.base.repo.id, authority.repositoryId, "PR base repository");
  const parents = git(root, ["show", "-s", "--format=%P", sourceSha]).split(" ");
  assert.equal(parents.length, 2, "tested source must be a two-parent merge");
  assert.equal(parents[1], headSha, "tested merge second parent differs from PR head");
  const baseSha = fullSha(parents[0]);
  const baseHistory = git(root, ["rev-list", "--first-parent", baseSha]).split("\n");
  assert.ok(baseHistory.includes(eventBaseSha), "event base is not in tested base history");
  return { kind: "pull-request", headSha, testedMergeSha: sourceSha, baseSha };
}
function sourceBinding(input: QualificationInput): Binding {
  const selected = targetBinding(input);
  if (selected.kind === "main-push") return selected;
  const { root, event, sourceSha } = input;
  const mainSha = fullSha(input.mainSha);
  assert.ok(event.pull_request, "missing pull request event");
  assert.equal(event.pull_request.base.ref, "main", "PR does not target main");
  const { baseSha } = selected;
  const mainHistory = git(root, ["rev-list", "--first-parent", fullSha(mainSha)]).split("\n");
  assert.ok(mainHistory.includes(baseSha), "tested base is not in captured main history");
  const included = git(root, ["merge-base", mainSha, sourceSha]) === mainSha;
  assert.ok(
    included || sourceEquivalent(root, baseSha, mainSha),
    `current main ${mainSha} is not included or scoring-equivalent to tested base ${baseSha}`,
  );
  return { ...selected, mainSha };
}
export function verifyBinding(
  input: QualificationInput & {
    run: Pick<HostRun, "repository" | "workflow_id" | "path" | "event" | "head_sha">;
  },
): Binding {
  const { eventName, sourceSha, run } = input;
  assert.equal(run.repository?.id, authority.repositoryId, "wrong run repository");
  assert.equal(run.workflow_id, authority.workflowId, "wrong workflow");
  assert.equal(run.path, authority.workflowPath, "wrong workflow path");
  assert.equal(run.event, eventName, "wrong run event");
  const selected = sourceBinding(input);
  assert.equal(
    run.head_sha,
    selected.kind === "pull-request" ? selected.headSha : sourceSha,
    "wrong host source",
  );
  return selected;
}
function selectLayerBaseline(input: QualificationInput): string {
  const selected = targetBinding(input);
  return selected.kind === "pull-request" ? selected.baseSha : selected.beforeSha;
}
export function selectBaseline(input: QualificationInput): string {
  const selected = sourceBinding(input);
  return selected.kind === "pull-request" ? selected.baseSha : selected.beforeSha;
}
async function binding(
  root: string,
  client: GithubClient,
  pinnedMain?: string,
): Promise<BoundQualification> {
  const event = json(envPath("GITHUB_EVENT_PATH"));
  assertEvent(event);
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0,
  );
  const run = await requestRun(client, `/actions/runs/${runId}/attempts/${attempt}`);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, attempt);
  let mainSha = pinnedMain;
  let observedMainAfter: string | null = null;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    const main = await client.request("/git/ref/heads/main");
    assertRecord(main);
    assertRecord(main.object);
    observedMainAfter = fullSha(main.object.sha);
    git(root, ["fetch", "--no-tags", "origin", observedMainAfter]);
    mainSha ??= observedMainAfter;
    assert.equal(
      git(root, ["merge-base", mainSha, observedMainAfter]),
      mainSha,
      "captured main is no longer in main history",
    );
  }
  const selected = verifyBinding({
    root,
    event,
    eventName: process.env.GITHUB_EVENT_NAME,
    sourceSha: fullSha(process.env.GITHUB_SHA),
    mainSha,
    run,
  });
  return { selected, run: { runId, attempt }, observedMainAfter };
}
export async function prepareQualification({
  root,
  client,
  output,
}: {
  root: string;
  client: GithubClient;
  output: string;
}): Promise<void> {
  const bound = await binding(root, client);
  const sourceSha = fullSha(process.env.GITHUB_SHA);
  const target =
    bound.selected.kind === "pull-request" ? bound.selected.mainSha : bound.selected.beforeSha;
  const trusted = oracleAt(root, bootstrap.sourceSha);
  assert.deepEqual(
    oracleAt(root, sourceSha).identity,
    trusted.identity,
    "candidate cannot change frozen identity",
  );
  let floor: MainFloor | AcceptedGainFloor | null = null;
  if (
    bound.selected.kind === "pull-request" ||
    target === "f6e3a9e67d56332b0476f3608e198bf74e8e12f3" ||
    terminalRecoveryTarget(root, target)
  ) {
    const prepared = await prepareCandidate({ root, client, ...bound, sourceSha });
    floor = prepared.floor.kind === "MainObservedFloor" ? prepared.floor.floor : prepared.floor;
  }
  write(output, {
    ...bound,
    sourceSha,
    capturedAt: new Date().toISOString(),
    floor,
    inputsSha256: digest(scoringInputs(root, sourceSha)),
  });
}
export function sealRaw({
  root,
  input,
  scorePath,
  output,
}: {
  root: string;
  input: string;
  scorePath: string;
  output: string;
}): void {
  const prepared = json(input);
  assertPrepared(prepared);
  assert.equal(prepared.sourceSha, git(root, ["rev-parse", "HEAD"]));
  assert.equal(prepared.sourceSha, process.env.GITHUB_SHA);
  assert.equal(prepared.run.runId, Number(process.env.GITHUB_RUN_ID));
  assert.equal(prepared.run.attempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(prepared.inputsSha256, digest(scoringInputs(root, prepared.sourceSha)));
  assert.deepEqual(
    prepared.selected,
    sourceBinding({
      root,
      event: eventFromEnvironment(),
      eventName: process.env.GITHUB_EVENT_NAME,
      sourceSha: prepared.sourceSha,
      mainSha: prepared.selected.kind === "pull-request" ? prepared.selected.mainSha : undefined,
    }),
    "prepared source binding mismatch",
  );
  const score = json(scorePath);
  assertScore(score);
  validateOwnScore(oracleAt(root, bootstrap.sourceSha), score);
  mkdirSync(output, { recursive: true });
  write(resolve(output, "raw.json"), {
    schema: 1,
    kind: "raw-score",
    ...prepared,
    resultSha256: digest(score),
    score,
  });
}
function eventFromEnvironment(): GitHubEvent {
  const event = json(envPath("GITHUB_EVENT_PATH"));
  assertEvent(event);
  return event;
}
export async function foldQualification({
  root,
  client,
  rawPath,
  output,
}: {
  root: string;
  client: GithubClient;
  rawPath: string;
  output: string;
}): Promise<Qualification> {
  const raw = json(rawPath);
  assertQualificationRaw(raw);
  const bound = await binding(
    root,
    client,
    raw.selected.kind === "pull-request" ? raw.selected.mainSha : undefined,
  );
  assert.equal(raw.schema, 1);
  assert.equal(raw.kind, "raw-score");
  assert.equal(raw.sourceSha, process.env.GITHUB_SHA);
  assert.equal(raw.run.runId, bound.run.runId);
  assert.ok(
    Number.isSafeInteger(raw.run.attempt) &&
      raw.run.attempt > 0 &&
      raw.run.attempt <= bound.run.attempt,
    "raw cannot come from a later attempt",
  );
  assert.deepEqual(raw.selected, bound.selected, "qualification binding mismatch");
  assert.equal(raw.inputsSha256, digest(scoringInputs(root, raw.sourceSha)));
  assert.equal(raw.resultSha256, digest(raw.score));
  const oracle = oracleAt(root, bootstrap.sourceSha);
  validateOwnScore(oracle, raw.score);
  await admitQualificationRaw({ root, client, raw });
  mkdirSync(output, { recursive: true });
  if (raw.floor?.kind === "AcceptedGainFloor")
    return foldAcceptedCandidate({ root, client, raw, bound, oracle, output });
  if (bound.selected.kind === "pull-request") {
    const { floor } = await resolveMainFloor({ root, sourceSha: bound.selected.mainSha, client });
    assert.ok(raw.floor, "missing captured pull request floor");
    validateFloor(oracle, raw.floor);
    assert.equal(raw.floor.sourceSha, floor.sourceSha);
    const combined = accumulateFloor({
      oracle,
      sourceSha: floor.sourceSha,
      predecessors: [floor, raw.floor],
      scores: [],
    });
    const result = {
      ...qualification(oracle, combined, raw.score, bound.selected),
      observedMainAfter: bound.observedMainAfter,
    };
    write(resolve(output, "qualification.json"), result);
    return result;
  }
  const { floor: previous } = await resolveMainFloor({
    root,
    sourceSha: bound.selected.beforeSha,
    client,
  });
  // Resolve every first-parent edge, even a multi-commit push with a feature/revert.
  const currentEvidence = mainEvidence({ root, oracle, client });
  const current = await currentEvidence.collect(raw.sourceSha);
  assert.ok(
    current.evidence.some(
      (item) =>
        item.kind === "raw" && item.runId === bound.run.runId && item.attempt === raw.run.attempt,
    ),
    "this exact completed raw producer/upload is required",
  );
  const { floor: covered } = await resolveMainFloor({ root, sourceSha: raw.sourceSha, client });
  const floor = accumulateFloor({
    oracle,
    sourceSha: raw.sourceSha,
    predecessors: [previous, covered].concat(current.floors),
    scores: current.scores,
    evidence: covered.evidence,
  });
  const result = {
    ...qualification(oracle, floor, raw.score, bound.selected),
    gainedSincePredecessor: Object.fromEntries(
      Object.entries(qualification(oracle, previous, raw.score, bound.selected).corpora).map(
        ([corpus, row]) => [corpus, row.gained],
      ),
    ),
  };
  writeMainFloor(output, floor, bound, result);
  write(resolve(output, "qualification.json"), result);
  return result;
}
async function foldAcceptedCandidate({
  root,
  client,
  raw,
  bound,
  oracle,
  output,
}: {
  root: string;
  client: GithubClient;
  raw: QualificationRaw;
  bound: BoundQualification;
  oracle: Oracle;
  output: string;
}): Promise<Qualification> {
  assertAcceptedRaw(raw);
  const prepared = await prepareCandidate({
    root,
    client,
    selected: bound.selected,
    sourceSha: raw.sourceSha,
    run: raw.run,
  });
  let result = {
    ...(await foldCandidate(prepared, raw)),
    observedMainAfter: bound.observedMainAfter,
  };
  if (bound.selected.kind === "main-push") {
    const current = await mainEvidence({ root, oracle, client }).collect(raw.sourceSha);
    assert.ok(
      current.evidence.some(
        (item) =>
          item.kind === "raw" && item.runId === raw.run.runId && item.attempt === raw.run.attempt,
      ),
      "completed current main producer is required",
    );
    const accepted = prepared.floor;
    assert.ok(accepted.kind === "AcceptedGainFloor");
    const acceptedEvidence: FloorEvidence[] = [
      {
        kind: "accepted-landed-pr-gains",
        landedMerge: accepted.landedMerge,
        recordDigest: accepted.acceptedRecordDigest,
        base: accepted.base.evidence,
        ...(accepted.evidence ? { evidence: accepted.evidence } : {}),
      },
    ];
    const floor = accumulateFloor({
      oracle,
      sourceSha: raw.sourceSha,
      predecessors: [
        { ...accepted.base, floorIds: accepted.ids, floorSha256: accepted.floorSha256 },
      ].concat(current.floors),
      scores: current.scores,
      evidence: acceptedEvidence.concat(current.evidence),
    });
    result = { ...result, ...qualification(oracle, floor, raw.score, bound.selected) };
    writeMainFloor(output, floor, bound, result);
  }
  write(resolve(output, "qualification.json"), result);
  return result;
}
function writeMainFloor(
  output: string,
  floor: MainFloor,
  bound: BoundQualification,
  result: Qualification,
): void {
  if (bound.selected.kind !== "main-push") return;
  write(resolve(output, "floor.json"), {
    ...floor,
    run: bound.run,
    beforeSha: bound.selected.beforeSha,
    lostIds: Object.values(result.corpora)
      .flatMap((row) => row.lost)
      .sort(),
  });
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = resolve(import.meta.dirname, "..");
  if (command === "baseline") {
    assert.equal(args.length, 1);
    assert.ok(["LAYERS_BASE_REF", "BASH_COMPAT_BASE_REF"].includes(args[0]));
    const select = args[0] === "LAYERS_BASE_REF" ? selectLayerBaseline : selectBaseline;
    const baseline = select({
      root,
      event: eventFromEnvironment(),
      eventName: process.env.GITHUB_EVENT_NAME,
      sourceSha: fullSha(process.env.GITHUB_SHA),
      mainSha:
        args[0] === "BASH_COMPAT_BASE_REF" && process.env.GITHUB_EVENT_NAME === "pull_request"
          ? git(root, ["rev-parse", "refs/remotes/origin/main"])
          : undefined,
    });
    appendFileSync(envPath("GITHUB_ENV"), `${args[0]}=${baseline}\n`);
    return;
  }
  if (command === "enforce") {
    assert.ok(args[0], "missing qualification path");
    const value = json(args[0]);
    assertRecord(value);
    assert.equal(value.ok, true, "required main passes were lost; see qualification artifact");
    return;
  }
  if (command === "raw") {
    assert.ok(args[0] && args[1] && args[2], "raw requires input, score and output paths");
    sealRaw({ root, input: args[0], scorePath: args[1], output: args[2] });
    return;
  }
  const client = githubClient(process.env.GH_TOKEN);
  if (command === "prepare") {
    assert.ok(args[0], "missing preparation output");
    await prepareQualification({ root, client, output: args[0] });
    return;
  }
  if (command === "fold") {
    assert.ok(args[0] && args[1], "fold requires raw input and output paths");
    await foldQualification({ root, client, rawPath: args[0], output: args[1] });
    return;
  }
  throw new Error(`unknown scoreboard CI command ${command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
