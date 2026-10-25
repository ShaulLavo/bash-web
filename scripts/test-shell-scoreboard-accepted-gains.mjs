import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertHistoricalJobs,
  assertRecordAppend,
  assertTerminalBlock,
  foldCandidate,
  prepareCandidate,
  recomputeAcceptedGains,
} from "./shell-scoreboard-accepted-gains.mjs";
import { authority } from "./shell-scoreboard-main.mjs";
import { qualification } from "./shell-scoreboard-floor.mjs";
import { digest } from "./shell-scoreboard.mjs";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.mjs";

const merge = "f6e3a9e67d56332b0476f3608e198bf74e8e12f3";
const fixture = scoreboardFixture("oils");
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
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
    steps: [{ name: "Rust quality and native tests", conclusion: "failure" }],
  }));
  const logs = `2026-10-25T03:22:28Z ---- ${testName} stdout ----\n2026-10-25T03:22:28Z \n2026-10-25T03:22:28Z thread '${testName}' (3805) panicked at engine/src/interpreter/command_builtin/tests.rs:644:9:\n2026-10-25T03:22:28Z assertion \`left == right\` failed\n2026-10-25T03:22:28Z   left: 151\n2026-10-25T03:22:28Z  right: 103\n2026-10-25T03:22:28Z test result: FAILED. 442 passed; 1 failed; 0 ignored;`;
  return { run, jobs, artifacts: [], logs };
}
const terminal = (value) => assertTerminalBlock(value.run, value.jobs, value.artifacts, value.logs);
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
  ]) {
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
  const run = { id: 1, run_attempt: 2, head_sha: "h", status: "completed", conclusion: "success" };
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
  const jobs = names.map((name) => ({
    name,
    run_id: 1,
    run_attempt: 2,
    head_sha: "h",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-25T00:00:00Z",
    completed_at: "2026-10-25T00:01:00Z",
  }));
  return { run, jobs, mergedAt: "2026-10-25T00:02:00Z" };
}
test("A07 each of the original ten jobs must be green on the original run before merge", () => {
  const check = (v) => assertHistoricalJobs(v.run, v.jobs, workflow, v.mergedAt);
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
function inputs() {
  const binding = {
    kind: "pull-request",
    headSha: "h",
    testedMergeSha: "c",
    baseSha: "a".repeat(40),
    mainSha: "a".repeat(40),
  };
  const score = fixture.score(["a", "x"]);
  const base = { ...fixture.floor(["a", "y"]), run: { runId: 2, attempt: 1 }, lostIds: [] };
  const raw = {
    schema: 1,
    kind: "raw-score",
    sourceSha: "c",
    selected: binding,
    run: { runId: 1, attempt: 2 },
    inputsSha256: "inputs",
    resultSha256: digest(score),
    score,
    floor: fixture.floor(["a"]),
  };
  const receipt = qualification(fixture.oracle, raw.floor, score, binding);
  const record = {
    original: {
      binding,
      run: raw.run,
      inputsSha256: "inputs",
      resultSha256: raw.resultSha256,
      capturedFloorSha256: raw.floor.floorSha256,
    },
    landed: { firstParent: base.sourceSha },
    baseFloor: { sourceSha: base.sourceSha, run: base.run, floorSha256: base.floorSha256 },
    gains: ["x"],
    gainsSha256: digest(["x"]),
    rowIdentitySha256: digest(
      score.cases.map(({ id, corpus, category, kind }) => ({ id, corpus, category, kind })),
    ),
    skipMembershipSha256: digest([]),
  };
  return JSON.parse(JSON.stringify({ record, raw, receipt, base }));
}
const recompute = (v) => recomputeAcceptedGains(fixture.oracle, v.record, v.raw, v.receipt, v.base);
test("A09 original qualification recomputes gains, unions all base IDs, and never emits main authority", () => {
  const value = inputs();
  const before = structuredClone(value);
  const result = recompute(value);
  assert.deepEqual(result.ids, ["a", "x", "y"]);
  assert.equal(result.kind, "AcceptedGainFloor");
  assert.equal(result.sourceSha, undefined);
  assert.equal(result.score, undefined);
  assert.equal(result.raw, undefined);
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
  ]) {
    const value = inputs();
    change(value);
    const changed = structuredClone(value);
    assert.throws(() => recompute(value), assert.AssertionError);
    assert.deepEqual(value, changed, "rejection must not mutate the evidence");
  }
});
test("A11 a serialized or caller-manufactured preparation cannot fold", async () => {
  for (const value of [{}, { floor: { kind: "AcceptedGainFloor", ids: ["a"] } }])
    await assert.rejects(foldCandidate(value, {}), /forged preparation/);
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
    const seen = [];
    const failure = new Error(reason);
    const client = {
      request: async (path) => {
        seen.push(path);
        throw failure;
      },
    };
    await assert.rejects(
      prepareCandidate({
        root,
        client,
        selected: { kind: "pull-request", mainSha: merge },
        sourceSha: merge,
        run: { runId: 1, attempt: 1 },
      }),
      (error) => error === failure,
    );
    assert.equal(seen.length, 1, "no record or older-floor lookup after evidence error");
  }
});
