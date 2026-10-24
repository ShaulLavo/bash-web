import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  accumulateFloor,
  bootstrap,
  qualification,
  validateFloor,
  validateOwnScore,
} from "./shell-scoreboard-floor.mjs";
import {
  admitQualificationRaw,
  authority,
  fullSha,
  git,
  githubClient,
  mainEvidence,
  oracleAt,
  resolveMainFloor,
  scoringInputs,
  sourceEquivalent,
} from "./shell-scoreboard-main.mjs";
import { digest } from "./shell-scoreboard.mjs";

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function write(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function verifyBinding({ root, event, eventName, sourceSha, mainSha, run }) {
  assert.equal(event.repository?.id, authority.repositoryId, "wrong event repository");
  assert.equal(run.repository?.id, authority.repositoryId, "wrong run repository");
  assert.equal(run.workflow_id, authority.workflowId, "wrong workflow");
  assert.equal(run.path, authority.workflowPath, "wrong workflow path");
  assert.equal(run.event, eventName, "wrong run event");
  assert.equal(
    git(root, ["rev-parse", "HEAD"]),
    fullSha(sourceSha),
    "checkout does not match tested source",
  );
  if (eventName === "push") {
    assert.equal(event.ref, "refs/heads/main", "only main pushes qualify");
    assert.equal(event.after, sourceSha, "wrong pushed source");
    assert.equal(run.head_sha, sourceSha, "wrong host push source");
    fullSha(event.before);
    assert.equal(
      git(root, ["merge-base", event.before, sourceSha]),
      event.before,
      "push predecessor not in tested main",
    );
    return { kind: "main-push", sourceSha, beforeSha: event.before };
  }
  assert.equal(eventName, "pull_request", "unsupported qualification event");
  const headSha = fullSha(event.pull_request.head.sha);
  const baseSha = fullSha(event.pull_request.base.sha);
  assert.equal(event.pull_request.base.ref, "main", "PR does not target main");
  assert.equal(event.pull_request.base.repo.id, authority.repositoryId, "PR base repository");
  assert.equal(run.head_sha, headSha, "host PR head changed");
  const parents = git(root, ["rev-list", "--parents", "-n", "1", sourceSha]).split(" ").slice(1);
  assert.deepEqual(parents, [baseSha, headSha], "tested merge parents differ from PR H/B");
  fullSha(mainSha);
  const included = git(root, ["merge-base", mainSha, sourceSha]) === mainSha;
  assert.ok(
    included || sourceEquivalent(root, baseSha, mainSha),
    `current main ${mainSha} is not included or scoring-equivalent to tested base ${baseSha}`,
  );
  return { kind: "pull-request", headSha, testedMergeSha: sourceSha, baseSha, mainSha };
}
async function binding(root, client, pinnedMain) {
  const event = json(process.env.GITHUB_EVENT_PATH);
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0,
  );
  const run = await client.request(`/actions/runs/${runId}/attempts/${attempt}`);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, attempt);
  let mainSha = pinnedMain;
  let observedMainAfter = null;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    const main = await client.request("/git/ref/heads/main");
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
    sourceSha: process.env.GITHUB_SHA,
    mainSha,
    run,
  });
  return { selected, run: { runId, attempt }, observedMainAfter };
}
export async function prepareQualification({ root, client, output }) {
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
  let floor = null;
  if (bound.selected.kind === "pull-request")
    floor = (await resolveMainFloor({ root, sourceSha: target, client })).floor;
  write(output, {
    ...bound,
    sourceSha,
    capturedAt: new Date().toISOString(),
    floor,
    inputsSha256: digest(scoringInputs(root, sourceSha)),
  });
}
export function sealRaw({ root, input, scorePath, output }) {
  const prepared = json(input);
  assert.equal(prepared.sourceSha, git(root, ["rev-parse", "HEAD"]));
  assert.equal(prepared.sourceSha, process.env.GITHUB_SHA);
  assert.equal(prepared.run.runId, Number(process.env.GITHUB_RUN_ID));
  assert.equal(prepared.run.attempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(prepared.inputsSha256, digest(scoringInputs(root, prepared.sourceSha)));
  const score = json(scorePath);
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
export async function foldQualification({ root, client, rawPath, output }) {
  const raw = json(rawPath);
  const bound = await binding(root, client, raw.selected.mainSha);
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
  if (bound.selected.kind === "pull-request") {
    const { floor } = await resolveMainFloor({ root, sourceSha: bound.selected.mainSha, client });
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
  write(resolve(output, "floor.json"), {
    ...floor,
    run: bound.run,
    beforeSha: bound.selected.beforeSha,
    lostIds: Object.values(result.corpora)
      .flatMap((row) => row.lost)
      .sort(),
  });
  write(resolve(output, "qualification.json"), result);
  return result;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = resolve(import.meta.dirname, "..");
  if (command === "enforce") {
    assert.equal(
      json(args[0]).ok,
      true,
      "required main passes were lost; see qualification artifact",
    );
    return;
  }
  if (command === "raw") {
    sealRaw({ root, input: args[0], scorePath: args[1], output: args[2] });
    return;
  }
  const client = githubClient(process.env.GH_TOKEN);
  if (command === "prepare") await prepareQualification({ root, client, output: args[0] });
  else if (command === "fold")
    await foldQualification({ root, client, rawPath: args[0], output: args[1] });
  else throw new Error(`unknown scoreboard CI command ${command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
