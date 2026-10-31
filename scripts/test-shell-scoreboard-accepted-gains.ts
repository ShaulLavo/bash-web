import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertFreshObservation,
  assertLandedIdentity,
  assertHistoricalJobs,
  assertRecordAppend,
  assertTerminalBlock,
  foldCandidate,
  prepareCandidate,
  recomputeAcceptedGains,
  assertAcceptedRecord,
} from "./shell-scoreboard-accepted-gains.ts";
import type {
  AcceptedGainRecord,
  AcceptedRawScore,
  HistoricalAcceptedRawScore,
  PreparedCandidate,
} from "./shell-scoreboard-accepted-gains.ts";
import { authority } from "./shell-scoreboard-main.ts";
import { qualification } from "./shell-scoreboard-floor.ts";
import type { MainFloor, Qualification } from "./shell-scoreboard-floor.ts";
import { digest } from "./shell-scoreboard.ts";
import type { PullRequestBinding, RunBinding } from "./shell-scoreboard.ts";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.ts";

const merge = "f6e3a9e67d56332b0476f3608e198bf74e8e12f3";
const historicalTestedMergeSha = "aaa853b275c27b9609918260f0e8cade3276d552";
const fixture = scoreboardFixture("oils");
const historicalWorkflowBytes = readFileSync(
  new URL("./test-data/ci-aaa853-workflow.yml", import.meta.url),
);
const historicalWorkflow = historicalWorkflowBytes.toString("utf8");
const historicalWorkflowBlob = createHash("sha1")
  .update(`blob ${historicalWorkflowBytes.byteLength}\0`)
  .update(historicalWorkflowBytes)
  .digest("hex");
const historicalWorkflowSha256 = createHash("sha256").update(historicalWorkflowBytes).digest("hex");
assert.equal(historicalWorkflowBlob, "8c96d5736d9806c8977f02236e4a2a490c794916");
assert.equal(
  historicalWorkflowSha256,
  "52a979a412258d066a67783afc80ab24137a3ad788af6c7c61a3a9198c5d8f1f",
);
const testName =
  "interpreter::command_builtin::tests::timed_function_declaration_output_releases_storage_on_cancel_and_drop";
function blocked() {
  const run = {
    id: 40157800143,
    run_attempt: 1,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    event: "push",
    head_branch: "main",
    head_sha: merge,
    status: "completed",
    conclusion: "failure",
  };
  const jobs = ["native", "own-shell-compatibility", "score-floor"].map((name) => ({
    id: 1,
    name,
    run_id: run.id,
    run_attempt: 1,
    head_sha: merge,
    status: "completed",
    conclusion: name === "native" ? "failure" : "skipped",
    steps: [
      {
        name: "Rust quality and native tests",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-10-25T00:00:00Z",
        completed_at: "2026-10-25T00:01:00Z",
        number: 1,
      },
    ],
  }));
  const artifacts: { name: string; [key: string]: unknown }[] = [];
  const logs = `2026-10-25T03:22:28Z ---- ${testName} stdout ----\n2026-10-25T03:22:28Z \n2026-10-25T03:22:28Z thread '${testName}' (3805) panicked at engine/src/interpreter/command_builtin/tests.rs:644:9:\n2026-10-25T03:22:28Z assertion \`left == right\` failed\n2026-10-25T03:22:28Z   left: 151\n2026-10-25T03:22:28Z  right: 103\n2026-10-25T03:22:28Z test result: FAILED. 442 passed; 1 failed; 0 ignored;`;
  return { run, jobs, artifacts, logs };
}
const terminal = (value: ReturnType<typeof blocked>) =>
  assertTerminalBlock(value.run, value.jobs, value.artifacts, value.logs);
test("A02 exact terminal native failure, skipped producers and absence are mandatory", () => {
  assert.doesNotThrow(() => terminal(blocked()));
  for (const change of [
    (v) => {
      v.run.status = "in_progress";
    },
    (v) => {
      v.run.conclusion = "cancelled";
    },
    (v) => {
      v.run.id++;
    },
    (v) => {
      v.run.run_attempt++;
    },
    (v) => {
      v.jobs[0].steps[0].name = "Build shared WASI guests and test binaries";
    },
    (v) => {
      v.logs = v.logs.replace("left: 151", "left: 152");
    },
    (v) => {
      v.logs += "\ntest result: FAILED. 1 failed";
    },
    (v) => {
      v.artifacts.push({ name: "own-shell-raw-invalid", expired: true });
    },
    (v) => {
      v.artifacts.push({ name: "own-shell-floor-invalid" });
    },
    (v) => {
      v.jobs[1].conclusion = "success";
    },
    (v) => {
      v.jobs[2].conclusion = "success";
    },
    (v) => {
      v.jobs[1].status = "queued";
    },
    (v) => {
      v.jobs[2].run_attempt++;
    },
    (v) => {
      v.jobs[0].head_sha = "f".repeat(40);
    },
  ] satisfies ((value: ReturnType<typeof blocked>) => void)[]) {
    const value = blocked();
    change(value);
    assert.throws(() => terminal(value), assert.AssertionError);
  }
});
test("A04 exact immutable blob prefix rejects delete/edit/reorder/duplicate and nonregular records", () => {
  const old = [
    { path: "a.json", mode: "100644", blob: "a" },
    { path: "b.json", mode: "100644", blob: "b" },
  ];
  const added = { path: "c.json", mode: "100644", blob: "c" };
  assert.doesNotThrow(() => assertRecordAppend(old, old.concat([added]), added.path));
  for (const after of [
    old,
    [added],
    old.toReversed().concat([added]),
    [{ ...old[0], blob: "edited" }, old[1], added],
    old.concat([added, added]),
    old.concat([{ ...added, mode: "120000" }]),
  ])
    assert.throws(() => assertRecordAppend(old, after, added.path), assert.AssertionError);
  assert.throws(() => assertRecordAppend(old.concat([added]), old.concat([added]), added.path));
});
function history() {
  const run = {
    id: 1,
    run_attempt: 2,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    event: "pull_request",
    head_branch: "fixture",
    head_sha: "h",
    status: "completed",
    conclusion: "success",
  };
  const names = [
    "prepare",
    "layers",
    "quality",
    "native",
    "wasi",
    "fuzz",
    "own-shell-compatibility",
    "score-floor",
    "browser",
    "shell",
  ];
  const jobs = names.map((name, index) => ({
    id: index + 1,
    name,
    run_id: 1,
    run_attempt: 2,
    head_sha: "h",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-25T00:00:00Z",
    completed_at: "2026-10-25T00:01:00Z",
    steps: [],
  }));
  return { run, jobs, mergedAt: "2026-10-25T00:02:00Z" };
}
test("A07 each of the original ten jobs must be green on the original run before merge", () => {
  const check = (value: ReturnType<typeof history>) =>
    assertHistoricalJobs(value.run, value.jobs, historicalWorkflow, value.mergedAt);
  assert.doesNotThrow(() => check(history()));
  for (let i = 0; i < 10; i++) {
    for (const patch of [
      { conclusion: "failure" },
      { status: "in_progress" },
      { run_id: 3 },
      { run_attempt: 1 },
      { head_sha: "other" },
      { completed_at: "2026-10-25T00:03:00Z" },
    ]) {
      const value = history();
      Object.assign(value.jobs[i], patch);
      assert.throws(() => check(value), assert.AssertionError);
    }
    const value = history();
    value.jobs.splice(i, 1);
    assert.throws(() => check(value), assert.AssertionError);
  }
});
test("A07 historical input does not depend on a local Git object cache", () => {
  const root = mkdtempSync(resolve(tmpdir(), "shell-scoreboard-history-"));
  try {
    mkdirSync(resolve(root, ".github/workflows"), { recursive: true });
    writeFileSync(resolve(root, authority.workflowPath), historicalWorkflowBytes);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const result = spawnSync(
      "git",
      ["show", `${historicalTestedMergeSha}:${authority.workflowPath}`],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /fatal:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("A07 current scheduling and extra or duplicate jobs cannot expand historical authority", () => {
  const { run, jobs, mergedAt } = history();
  const currentWorkflow = readFileSync(
    new URL(`../${authority.workflowPath}`, import.meta.url),
    "utf8",
  );
  assert.throws(
    () => assertHistoricalJobs(run, jobs, currentWorkflow, mergedAt),
    /reviewed historical Shell job set/,
  );
  for (const name of ["own-shell-scoreboard", "own-shell-observation", "prepare"])
    assert.throws(
      () =>
        assertHistoricalJobs(
          run,
          jobs.concat([{ ...jobs[0], name }]),
          historicalWorkflow,
          mergedAt,
        ),
      /missing\/extra historical job/,
    );
});
interface RecomputeInputs {
  record: AcceptedGainRecord;
  raw: HistoricalAcceptedRawScore;
  receipt: Qualification;
  base: MainFloor & { run: RunBinding; lostIds: string[] };
}
function inputs(): RecomputeInputs {
  const binding: PullRequestBinding = {
    kind: "pull-request",
    headSha: "h",
    testedMergeSha: "c",
    baseSha: "a".repeat(40),
    mainSha: "a".repeat(40),
  };
  const score = structuredClone(fixture.score(["a", "x"]));
  const base = structuredClone({
    ...fixture.floor(["a", "y"]),
    run: { runId: 2, attempt: 1 },
    lostIds: [],
  });
  const raw: HistoricalAcceptedRawScore = {
    schema: 1,
    kind: "raw-score",
    sourceSha: "c",
    selected: binding,
    run: { runId: 1, attempt: 2 },
    capturedAt: "2026-10-25T00:00:00Z",
    inputsSha256: "inputs",
    resultSha256: digest(score),
    score,
    floor: structuredClone(fixture.floor(["a"])),
  };
  const receipt = qualification(fixture.oracle, raw.floor, score, binding);
  const record: AcceptedGainRecord = {
    original: {
      binding: structuredClone(binding),
      run: structuredClone(raw.run),
      inputsSha256: "inputs",
      resultSha256: raw.resultSha256,
      capturedFloorSha256: raw.floor.floorSha256,
    },
    landed: { firstParent: base.sourceSha },
    baseFloor: {
      sourceSha: base.sourceSha,
      run: structuredClone(base.run),
      floorSha256: base.floorSha256,
    },
    gains: ["x"],
    gainsSha256: digest(["x"]),
    rowIdentitySha256: digest(
      score.cases.map(({ id, corpus, category, kind }) => ({ id, corpus, category, kind })),
    ),
    skipMembershipSha256: digest([]),
  };
  return { record, raw, receipt, base };
}
const recompute = (value: RecomputeInputs) =>
  recomputeAcceptedGains(fixture.oracle, value.record, value.raw, value.receipt, value.base);
test("A09 original qualification recomputes gains, unions all base IDs, and never emits main authority", () => {
  const value = inputs();
  const before = structuredClone(value);
  const result = recompute(value);
  assert.deepEqual(result.ids, ["a", "x", "y"]);
  assert.equal(result.kind, "AcceptedGainFloor");
  assert.equal("sourceSha" in result, false);
  assert.equal("score" in result, false);
  assert.equal("raw" in result, false);
  assert.deepEqual(value, before);
  assert.ok(Object.isFrozen(result.ids));
});
test("A08/A09/A10/A13 changed provenance, frozen judging inputs, stored gain membership and losses reject", () => {
  for (const change of [
    (v) => {
      v.raw.run.attempt++;
    },
    (v) => {
      v.raw.sourceSha = "other";
    },
    (v) => {
      v.raw.selected.headSha = "other";
    },
    (v) => {
      v.raw.inputsSha256 = "other";
    },
    (v) => {
      v.raw.resultSha256 = "other";
    },
    (v) => {
      v.raw.floor.floorSha256 = "other";
    },
    (v) => {
      v.raw.score.identity.oracle = "other";
    },
    (v) => {
      v.raw.score.cases[0].kind = "external";
    },
    (v) => {
      v.raw.score.cases[0].outcome = "skip";
    },
    (v) => {
      v.receipt.ok = false;
    },
    (v) => {
      v.receipt.floorSha256 = "other";
    },
    (v) => {
      v.record.gains = [];
    },
    (v) => {
      v.record.gains = ["x", "x"];
    },
    (v) => {
      v.record.gains = ["y"];
    },
    (v) => {
      v.record.gains = ["x", "a"];
    },
    (v) => {
      v.record.gainsSha256 = "other";
    },
    (v) => {
      v.record.rowIdentitySha256 = "other";
    },
    (v) => {
      v.record.skipMembershipSha256 = "other";
    },
    (v) => {
      v.base.sourceSha = "b".repeat(40);
    },
    (v) => {
      v.base.run.attempt++;
    },
    (v) => {
      v.base.lostIds = ["a"];
    },
    (v) => {
      v.base.floorIds = ["a"];
    },
    (v) => {
      v.raw.floor = fixture.floor(["a", "y"]);
    },
  ] satisfies ((value: RecomputeInputs) => void)[]) {
    const value = inputs();
    change(value);
    const changed = structuredClone(value);
    assert.throws(() => recompute(value), assert.AssertionError);
    assert.deepEqual(value, changed, "rejection must not mutate the evidence");
  }
});
test("A11 a serialized or caller-manufactured preparation cannot fold", async () => {
  const value = inputs();
  const accepted = recompute(value);
  const raw: AcceptedRawScore = { ...value.raw, floor: accepted };
  const prepared: PreparedCandidate = {
    floor: accepted,
    sourceSha: raw.sourceSha,
    selected: raw.selected,
    run: raw.run,
  };
  for (const candidate of [prepared, { ...prepared, floor: { ...accepted, ids: ["a"] } }])
    await assert.rejects(foldCandidate(candidate, raw), /forged preparation/);
});
test("A01 authenticated read errors never become evidence absence", async () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const reason of [
    "malformed",
    "expired",
    "unauthorized",
    "digest-invalid",
    "transport-unavailable",
  ]) {
    const seen: string[] = [];
    const failure = new Error(reason);
    const client = {
      request: async (path: string) => {
        seen.push(path);
        throw failure;
      },
    };
    await assert.rejects(
      prepareCandidate({
        root,
        client,
        selected: {
          kind: "pull-request",
          headSha: "h",
          testedMergeSha: merge,
          baseSha: "a".repeat(40),
          mainSha: merge,
        },
        sourceSha: merge,
        run: { runId: 1, attempt: 1 },
      }),
      (error) => error === failure,
    );
    assert.equal(seen.length, 1, "no record or older-floor lookup after evidence error");
  }
});

function landed() {
  const record: unknown = JSON.parse(
    readFileSync(new URL(`../scoreboard/accepted-gains/${merge}.json`, import.meta.url), "utf8"),
  );
  assertAcceptedRecord(record);
  const pr = {
    number: 102,
    merged: true,
    merge_commit_sha: merge,
    merged_at: "2026-10-25T00:02:00Z",
    base: { ref: "main", repo: { id: authority.repositoryId } },
    head: { sha: record.original.binding.headSha, repo: { id: authority.repositoryId } },
  };
  const facts = {
    parents: [record.landed.firstParent],
    tree: record.landed.tree,
    originalParents: [record.original.binding.baseSha, record.original.binding.headSha],
    originalTree: record.original.tree,
    ancestor: record.original.binding.baseSha,
    composedTree: record.landed.tree,
    inputsSha256: record.original.inputsSha256,
  };
  return { record, pr, facts };
}
test("A05/A06 landed identity rejects self-certification, different trees, topology and composition", () => {
  const check = (value: ReturnType<typeof landed>) =>
    assertLandedIdentity(value.record, value.pr, value.facts);
  assert.doesNotThrow(() => check(landed()));
  for (const change of [
    (v) => {
      v.pr.number = 105;
    },
    (v) => {
      v.pr.merged = false;
    },
    (v) => {
      v.pr.merge_commit_sha = "other";
    },
    (v) => {
      v.pr.base.repo.id++;
    },
    (v) => {
      v.pr.head.repo.id++;
    },
    (v) => {
      v.pr.head.sha = "other";
    },
    (v) => {
      v.facts.parents = ["other"];
    },
    (v) => {
      v.facts.tree = "other";
    },
    (v) => {
      v.facts.originalParents.reverse();
    },
    (v) => {
      v.facts.originalTree = v.record.landed.tree;
    },
    (v) => {
      v.facts.ancestor = "other";
    },
    (v) => {
      v.facts.composedTree = v.record.original.tree;
    },
    (v) => {
      v.facts.inputsSha256 = "other";
    },
    (v) => {
      v.record.original.binding.mainSha = "other";
    },
  ] satisfies ((value: ReturnType<typeof landed>) => void)[]) {
    const value = landed();
    change(value);
    assert.throws(() => check(value), assert.AssertionError);
  }
});
function fresh() {
  const raw = { capturedAt: "2026-10-25T00:00:01Z" };
  const producer = {
    steps: [
      {
        name: "Bind qualification and resolve PR main floor",
        started_at: "2026-10-25T00:00:00Z",
        completed_at: "2026-10-25T00:00:02Z",
      },
      {
        name: "Observe compatibility with the same-job node build",
        started_at: "2026-10-25T00:00:03Z",
        completed_at: "2026-10-25T00:00:04Z",
      },
      {
        name: "Seal complete raw score",
        started_at: "2026-10-25T00:00:05Z",
        completed_at: "2026-10-25T00:00:06Z",
      },
    ].map((step, index) => ({
      ...step,
      number: index + 1,
      status: "completed",
      conclusion: "success",
    })),
  };
  return { raw, producer };
}
test("A12 observation must follow captured preparation and finish before sealing", () => {
  const check = (value: ReturnType<typeof fresh>) =>
    assertFreshObservation(value.raw, value.producer);
  assert.doesNotThrow(() => check(fresh()));
  for (const change of [
    (v) => {
      v.raw.capturedAt = "2026-10-24T00:00:00Z";
    },
    (v) => {
      v.raw.capturedAt = "invalid";
    },
    (v) => {
      v.producer.steps[1].number = 1;
    },
    (v) => {
      v.producer.steps[1].started_at = v.raw.capturedAt;
    },
    (v) => {
      v.producer.steps[1].completed_at = "2026-10-25T00:00:07Z";
    },
    (v) => {
      v.producer.steps[1].conclusion = "skipped";
    },
    (v) => {
      v.producer.steps[2].status = "in_progress";
    },
  ] satisfies ((value: ReturnType<typeof fresh>) => void)[]) {
    const value = fresh();
    change(value);
    assert.throws(() => check(value), assert.AssertionError);
  }
});

test("same-second host timestamps still prove fresh ordered observation without a CI cycle", () => {
  const value = fresh();
  value.raw.capturedAt = "2026-10-25T00:00:02.500Z";
  value.producer.steps[1].started_at = "2026-10-25T00:00:02Z";
  assert.doesNotThrow(() => assertFreshObservation(value.raw, value.producer));
  value.producer.steps[1].completed_at = "2026-10-25T00:00:02Z";
  assert.throws(() => assertFreshObservation(value.raw, value.producer), /stale Waffle/);
});
