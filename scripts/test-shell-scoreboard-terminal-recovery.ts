import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { prepareCandidate, foldCandidate } from "./shell-scoreboard-accepted-gains.ts";
import {
  terminalCut,
  terminalRecord,
  assertTerminalCancelled,
  assertTerminalJobs,
  assertTerminalLanded,
  recomputeTerminalRequirement,
  assertTerminalFreshObservation,
} from "./shell-scoreboard-terminal-recovery.ts";
import {
  authority,
  git,
  oracleAt,
  resolveMainFloor,
  artifactJson,
  scoringInputs,
} from "./shell-scoreboard-main.ts";
import { bootstrap, qualification, compareFloor } from "./shell-scoreboard-floor.ts";
import { digest, bytesDigest, summarize } from "./shell-scoreboard.ts";
import { prepareQualification, sealRaw, foldQualification } from "./scoreboard-ci.ts";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.ts";
const project = resolve(import.meta.dirname, "..");
const record = JSON.parse(readFileSync(resolve(project, terminalCut.recordPath), "utf8"));
const sha = (number) => number.toString(16).padStart(40, "0");
function hostFixture() {
  const responses = JSON.parse(
    gunzipSync(readFileSync(new URL("./test-data/terminal-floor-host.json.gz", import.meta.url))),
  );
  const values = new Map(
    responses.map(({ path, type, value }) => [
      `${type}:${path}`,
      type === "bytes" ? Buffer.from(value, "base64") : value,
    ]),
  );
  values.set("json:/git/ref/heads/main", { object: { sha: terminalCut.sourceSha } });
  const client = {
    async request(path, type = "json") {
      const key = `${type}:${path}`;
      assert.ok(values.has(key), `unexpected host request ${key}`);
      const value = values.get(key);
      return type === "json" ? structuredClone(value) : value;
    },
  };
  return { values, client };
}
async function withCandidate(body) {
  const root = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "terminal-floor-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Score fixture"]);
    git(root, ["config", "user.email", "score@example.invalid"]);
    const common = git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    mkdirSync(resolve(root, ".git/objects/info"), { recursive: true });
    writeFileSync(resolve(root, ".git/objects/info/alternates"), `${resolve(common, "objects")}\n`);
    execFileSync("git", ["index-pack", "--stdin"], {
      cwd: root,
      input: readFileSync(new URL("./test-data/terminal-floor-sources.pack", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    });
    git(root, ["remote", "add", "origin", root]);
    git(root, ["read-tree", terminalCut.sourceSha]);
    const bytes = readFileSync(resolve(project, terminalCut.recordPath));
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: bytes,
      encoding: "utf8",
    }).trim();
    git(root, ["update-index", "--add", "--cacheinfo", "100644", blob, terminalCut.recordPath]);
    const tree = git(root, ["write-tree"]);
    const sourceSha = git(root, [
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-p",
      terminalCut.sourceSha,
      "-m",
      "fixed-cut recovery fixture",
    ]);
    git(root, ["update-ref", "HEAD", sourceSha]);
    const paths = git(root, [
      "ls-tree",
      "-r",
      "--name-only",
      sourceSha,
      "--",
      "scoreboard/accepted-gains",
    ]).split("\n");
    for (const path of paths) {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(resolve(root, path), git(root, ["show", `${sourceSha}:${path}`]) + "\n");
    }
    const selected = { kind: "main-push", sourceSha, beforeSha: terminalCut.sourceSha };
    await body({ root, sourceSha, selected });
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}
test("cancelled-parent fixture recovers all 4764 accepted IDs without relabelling PR evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(async (candidate) => {
    const { client } = hostFixture();
    await assert.rejects(
      resolveMainFloor({ ...candidate, sourceSha: terminalCut.sourceSha, client }),
      /missing-non-equivalent-main-score.*69ed868e/,
    );
    const prepared = await prepareCandidate({
      ...candidate,
      client,
      run: { runId: 1, attempt: 1 },
    });
    assert.equal(prepared.floor.kind, "AcceptedGainFloor");
    assert.equal(prepared.floor.base.sourceSha, terminalCut.baseSha);
    assert.equal(prepared.floor.ids.length, 4764);
    assert.equal(prepared.floor.floorSha256, record.requirement.floorSha256);
    assert.equal(prepared.floor.sourceSha, undefined);
    assert.equal(prepared.floor.score, undefined);
    for (const id of ["bashkit-suite:blackbox-edge-cases:232", "brush-suite:ifs:1"])
      assert.ok(prepared.floor.ids.includes(id));
    await assert.rejects(foldCandidate(structuredClone(prepared), {}), /forged preparation/);
  });
});
test("terminal receipt rejects workspace edits, changed claims and unrelated candidate sources", async () => {
  await withCandidate(async ({ root, sourceSha, selected }) => {
    assert.deepEqual(terminalRecord(root, sourceSha, selected), record);
    writeFileSync(resolve(root, terminalCut.recordPath), "{}\n");
    assert.throws(() => terminalRecord(root, sourceSha, selected), /mutable accepted records/);
    assert.throws(() => terminalRecord(root, sha(1), selected), /candidate checkout changed/);
    writeFileSync(
      resolve(root, terminalCut.recordPath),
      readFileSync(resolve(project, terminalCut.recordPath)),
    );
    assert.throws(
      () => terminalRecord(root, sourceSha, { ...selected, beforeSha: terminalCut.baseSha }),
      /single-commit push/,
    );
  });
});
test("fixed-cut original jobs, cancelled runs and topology keep all host identity checks", () => {
  const { values } = hostFixture();
  const get = (path) => structuredClone(values.get(`json:${path}`));
  const claim = record.cancelled[0];
  const run = get(`/actions/runs/${claim.runId}/attempts/1`);
  const jobs = get(`/actions/runs/${claim.runId}/attempts/1/jobs?per_page=100`).jobs;
  const artifacts = get(`/actions/runs/${claim.runId}/artifacts?per_page=100`).artifacts;
  assert.doesNotThrow(() => assertTerminalCancelled(claim, run, jobs, artifacts));
  for (const patch of [
    { conclusion: "failure" },
    { repository: { id: 1 } },
    { head_sha: sha(1) },
    { run_attempt: 2 },
  ])
    assert.throws(() => assertTerminalCancelled(claim, { ...run, ...patch }, jobs, artifacts));
  assert.throws(
    () => assertTerminalCancelled(claim, run, jobs, [{ name: "own-shell-raw-foreign" }]),
    /normal main evidence/,
  );
  const original = record.landed[1];
  const facts = {
    parents: [original.landed.firstParent],
    tree: original.landed.tree,
    testedParents: [original.original.binding.baseSha, original.original.binding.headSha],
    testedTree: original.original.tree,
    ancestor: original.original.binding.baseSha,
    composedTree: original.landed.tree,
    inputsSha256: original.original.inputsSha256,
  };
  const pr = get(`/pulls/${original.landed.pr}`);
  assert.notEqual(facts.tree, facts.testedTree);
  assert.doesNotThrow(() => assertTerminalLanded(original, pr, facts));
  for (const changed of [
    { ...pr, merged: false },
    { ...pr, merge_commit_sha: sha(2) },
    { ...pr, head: { ...pr.head, repo: { id: 1 } } },
    { ...pr, base: { ...pr.base, ref: "other" } },
  ])
    assert.throws(() => assertTerminalLanded(original, changed, facts));
  for (const patch of [
    { composedTree: sha(1) },
    { ancestor: sha(1) },
    { testedParents: [sha(1)] },
    { parents: [sha(1)] },
    { inputsSha256: "forged" },
  ])
    assert.throws(() => assertTerminalLanded(original, pr, { ...facts, ...patch }));
  const originalRun = get(`/actions/runs/${original.original.run.runId}/attempts/2`);
  const originalJobs = get(`/actions/runs/${originalRun.id}/attempts/2/jobs?per_page=100`).jobs;
  const workflow = git(project, ["show", `${terminalCut.sourceSha}:${authority.workflowPath}`]);
  assert.doesNotThrow(() => assertTerminalJobs(originalRun, originalJobs, workflow, pr.merged_at));
  for (const patch of [
    { run_id: 1 },
    { head_sha: sha(1) },
    { conclusion: "failure" },
    { completed_at: pr.merged_at },
  ])
    assert.throws(() =>
      assertTerminalJobs(
        originalRun,
        [{ ...originalJobs[0], ...patch }].concat(originalJobs.slice(1)),
        workflow,
        pr.merged_at,
      ),
    );
});
function membershipFixture() {
  const fixture = scoreboardFixture("oils");
  const base = { ...fixture.floor(["a"], sha(1)), run: { runId: 10, attempt: 1 }, lostIds: [] };
  const entries = [sha(2), sha(3), sha(4)].map((mergeCommit, index) => {
    const binding = {
      kind: "pull-request",
      headSha: sha(index + 10),
      testedMergeSha: sha(index + 20),
      baseSha: sha(1),
      mainSha: sha(1),
    };
    const addition = [["x"], ["y"], []][index];
    const score = fixture.score(["a"].concat(addition));
    const raw = {
      schema: 1,
      kind: "raw-score",
      sourceSha: binding.testedMergeSha,
      selected: structuredClone(binding),
      run: { runId: index + 20, attempt: 2 },
      inputsSha256: digest(index),
      resultSha256: digest(score),
      score,
      floor: base,
    };
    const receipt = qualification(fixture.oracle, base, score, binding);
    const gains = Object.values(receipt.corpora)
      .flatMap((row) => row.gained)
      .sort();
    const record = {
      landed: { mergeCommit, firstParent: sha(index + 1) },
      original: {
        binding,
        run: raw.run,
        inputsSha256: raw.inputsSha256,
        resultSha256: raw.resultSha256,
        capturedFloorSha256: base.floorSha256,
      },
      gains,
      gainsSha256: digest(gains),
    };
    return { record, raw, receipt };
  });
  const record = {
    base: { sourceSha: base.sourceSha, run: base.run, floorSha256: base.floorSha256 },
    landed: entries.map((item) => item.record),
    requirement: { count: 3, floorSha256: digest(["a", "x", "y"]) },
  };
  return { fixture, base, record, entries };
}
test("stale-base accepted contributions union every captured ID; later PR cannot erase earlier gains", () => {
  const { fixture, base, record, entries } = membershipFixture();
  const required = recomputeTerminalRequirement(fixture.oracle, record, base, entries);
  assert.deepEqual(required.floorIds, ["a", "x", "y"]);
  assert.equal(compareFloor(fixture.oracle, required, fixture.score(["a", "x", "y"])).ok, true);
  assert.equal(compareFloor(fixture.oracle, required, fixture.score(["a"])).ok, false);
  assert.throws(
    () => recomputeTerminalRequirement(fixture.oracle, record, base, entries.slice(1)),
    /incomplete receipt chain/,
  );
  for (const mutate of [
    (v) => {
      v.entries[1].record.landed.firstParent = sha(99);
    },
    (v) => {
      v.entries[1].raw.sourceSha = sha(99);
    },
    (v) => {
      v.entries[1].raw.selected.headSha = sha(99);
    },
    (v) => {
      v.entries[1].raw.score.cases[0].outcome = "skip";
    },
    (v) => {
      v.entries[1].receipt.ok = false;
    },
    (v) => {
      v.entries[1].raw.score.identity.oracle = "forged";
    },
    (v) => {
      v.record.requirement.count = 1;
    },
  ]) {
    const value = structuredClone({ record, entries });
    mutate(value);
    assert.throws(() =>
      recomputeTerminalRequirement(fixture.oracle, value.record, base, value.entries),
    );
  }
});
function observationFixture() {
  const step = (name, number, start, end) => ({
    name,
    number,
    status: "completed",
    conclusion: "success",
    started_at: `2026-10-29T10:00:${start}Z`,
    completed_at: `2026-10-29T10:00:${end}Z`,
  });
  const raw = {
    sourceSha: sha(1),
    run: { runId: 10, attempt: 2 },
    selected: { kind: "main-push" },
    capturedAt: "2026-10-29T10:00:01Z",
  };
  const jobs = ["own-shell-observation", "own-shell-compatibility"].map((name) => ({
    name,
    run_id: 10,
    run_attempt: 2,
    head_sha: sha(1),
    status: "completed",
    conclusion: "success",
    steps: [],
  }));
  jobs[0].steps = [
    step("Bind qualification and resolve PR main floor", 1, "00", "02"),
    step("Observe compatibility with the shared node build", 2, "02", "04"),
  ];
  jobs[1].steps = [step("Seal complete raw score", 1, "04", "05")];
  return { raw, jobs };
}
test("current shared-job observation is fresh, source-bound and sealed only after observing", () => {
  const valid = observationFixture();
  assert.doesNotThrow(() => assertTerminalFreshObservation(valid.raw, valid.jobs));
  for (const mutate of [
    (v) => {
      v.raw.capturedAt = "2026-10-29T09:00:00Z";
    },
    (v) => {
      v.jobs[0].head_sha = sha(2);
    },
    (v) => {
      v.jobs[1].run_attempt = 1;
    },
    (v) => {
      v.jobs[0].conclusion = "cancelled";
    },
    (v) => {
      v.jobs[1].steps[0].started_at = "2026-10-29T10:00:02Z";
    },
  ]) {
    const value = observationFixture();
    mutate(value);
    assert.throws(() => assertTerminalFreshObservation(value.raw, value.jobs));
  }
});
function publishCandidate(host, candidate, raw) {
  const runId = raw.run.runId;
  const attempt = raw.run.attempt;
  const pullRequest = candidate.selected.kind === "pull-request";
  const headSha = pullRequest ? candidate.selected.headSha : candidate.sourceSha;
  const start = "2026-10-29T10:02:00Z",
    end = "2026-10-29T10:02:02Z";
  const run = {
    id: runId,
    run_attempt: attempt,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    head_sha: headSha,
    head_branch: pullRequest ? "fixture-recovery" : "main",
    event: pullRequest ? "pull_request" : "push",
    status: "in_progress",
    conclusion: null,
  };
  const step = (name, number, started_at, completed_at) => ({
    name,
    number,
    started_at,
    completed_at,
    status: "completed",
    conclusion: "success",
  });
  const common = {
    run_id: runId,
    run_attempt: attempt,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
  };
  const observer = {
    ...common,
    id: 99991 + attempt * 10,
    name: "own-shell-observation",
    steps: [
      step(
        "Bind qualification and resolve PR main floor",
        1,
        "2026-10-29T10:00:00Z",
        "2026-10-29T10:00:02Z",
      ),
      step(
        "Observe compatibility with the shared node build",
        2,
        "2026-10-29T10:00:02Z",
        "2026-10-29T10:01:00Z",
      ),
    ],
  };
  const sealer = {
    ...common,
    id: 99992 + attempt * 10,
    name: "own-shell-compatibility",
    steps: [
      step("Seal complete raw score", 1, "2026-10-29T10:01:00Z", start),
      step("Upload complete raw score", 2, start, end),
    ],
  };
  const bytes = execFileSync(
    "python3",
    [
      "-c",
      "import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('raw.json',sys.stdin.buffer.read())\nsys.stdout.buffer.write(b.getvalue())",
    ],
    { input: JSON.stringify(raw), maxBuffer: 16 * 1024 * 1024 },
  );
  const artifact = {
    id: 99993 + attempt,
    name: `own-shell-raw-${candidate.sourceSha}-${runId}-${attempt}`,
    digest: `sha256:${bytesDigest(bytes)}`,
    expired: false,
    created_at: "2026-10-29T10:02:01Z",
    expires_at: "2027-01-01T00:00:00Z",
    workflow_run: {
      id: runId,
      head_sha: headSha,
      head_repository_id: authority.repositoryId,
    },
  };
  const set = (path, value, type = "json") => host.values.set(`${type}:${path}`, value);
  set(`/actions/runs/${runId}/attempts/${attempt}`, run);
  set(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
    total_count: 2,
    jobs: [observer, sealer],
  });
  const existing = host.values.get(`json:/actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts = (existing?.artifacts ?? [])
    .filter((item) => item.id !== artifact.id)
    .concat([artifact]);
  set(`/actions/runs/${runId}/artifacts?per_page=100`, {
    total_count: artifacts.length,
    artifacts,
  });
  set(`/actions/artifacts/${artifact.id}`, artifact);
  set(`/actions/artifacts/${artifact.id}/zip`, bytes, "bytes");
  set(
    `/actions/jobs/${sealer.id}/logs`,
    `2026-10-29T10:02:01.100Z SHA256 digest of uploaded artifact zip is ${bytesDigest(bytes)}\n2026-10-29T10:02:01.200Z Artifact ${artifact.name} has been successfully uploaded! Final size is ${bytes.length} bytes. Artifact ID is ${artifact.id}\n`,
    "text",
  );
  set(
    `/actions/workflows/${authority.workflowId}/runs?event=push&head_sha=${candidate.sourceSha}&per_page=100`,
    { total_count: 1, workflow_runs: [run] },
  );
}
function currentScore(host) {
  const listing = host.values.get("json:/actions/runs/40841852105/artifacts?per_page=100");
  const metadata = listing.artifacts.find((item) => item.id === 12883574814);
  return artifactJson(
    host.values.get("bytes:/actions/artifacts/12883574814/zip"),
    metadata,
    "raw.json",
  ).score;
}
async function withQualificationEnvironment(candidate, body) {
  const eventPath = resolve(candidate.root, "event.json");
  const pullRequest = candidate.selected.kind === "pull-request";
  const repository = { id: authority.repositoryId };
  const event = pullRequest
    ? {
        repository,
        pull_request: {
          head: { sha: candidate.selected.headSha },
          base: { ref: "main", sha: candidate.selected.baseSha, repo: repository },
        },
      }
    : {
        repository,
        ref: "refs/heads/main",
        after: candidate.sourceSha,
        before: candidate.selected.beforeSha,
      };
  writeFileSync(eventPath, JSON.stringify(event));
  const environment = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: pullRequest ? "pull_request" : "push",
    GITHUB_SHA: candidate.sourceSha,
    GITHUB_RUN_ID: "99990",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
async function assertMainLifecycle(candidate) {
  await withQualificationEnvironment(candidate, () => runMainLifecycle(candidate));
}
async function captureFixture(candidate, host) {
  const { client } = host;
  const run = { runId: 99990, attempt: 1 };
  const prepared = resolve(candidate.root, "prepared.json");
  const rawDir = resolve(candidate.root, "raw");
  const output = resolve(candidate.root, "folded");
  const scorePath = resolve(candidate.root, "score.json");
  const score = currentScore(host);
  const initial = {
    schema: 1,
    kind: "raw-score",
    run,
    sourceSha: candidate.sourceSha,
    selected: candidate.selected,
    score,
  };
  publishCandidate(host, candidate, initial);
  await prepareQualification({ root: candidate.root, client, output: prepared });
  const capture = JSON.parse(readFileSync(prepared, "utf8"));
  assert.equal(capture.floor.kind, "AcceptedGainFloor");
  assert.equal(capture.floor.ids.length, 4764);
  writeFileSync(scorePath, JSON.stringify(score));
  sealRaw({ root: candidate.root, input: prepared, scorePath, output: rawDir });
  const rawPath = resolve(rawDir, "raw.json");
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  publishCandidate(host, candidate, raw);
  return { raw, rawPath, output, score, run };
}
async function runMainLifecycle(candidate) {
  const host = hostFixture();
  const { client } = host;
  const { raw, rawPath, output, score, run } = await captureFixture(candidate, host);
  const result = await foldQualification({ root: candidate.root, client, rawPath, output });
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding, candidate.selected);
  const floor = JSON.parse(readFileSync(resolve(output, "floor.json"), "utf8"));
  assert.equal(floor.sourceSha, candidate.sourceSha);
  assert.deepEqual(floor.run, run);
  assert.equal(floor.beforeSha, terminalCut.sourceSha);
  assert.equal(floor.floorIds.length, 4764);
  assert.deepEqual(floor.lostIds, []);
  const currentEvidence = floor.evidence.find(
    (item) => item.kind === "raw" && item.sourceSha === candidate.sourceSha,
  );
  assert.ok(currentEvidence, "new main authority requires this source's completed producer");
  for (const removed of ["bashkit-suite:blackbox-edge-cases:232", "brush-suite:ifs:1"]) {
    const changed = structuredClone(raw);
    changed.score.cases.find((row) => row.id === removed).outcome = "fail";
    changed.score.counts = summarize(changed.score);
    changed.resultSha256 = digest(changed.score);
    publishCandidate(host, candidate, changed);
    writeFileSync(rawPath, JSON.stringify(changed));
    await assert.rejects(
      foldQualification({ root: candidate.root, client, rawPath, output }),
      /accepted passing IDs were lost/,
    );
  }
  const extra = score.cases.find(
    (row) => row.kind === "builtins-only" && !row.excluded && row.outcome === "fail",
  ).id;
  const earlier = structuredClone(raw);
  earlier.score.cases.find((row) => row.id === extra).outcome = "pass";
  earlier.score.counts = summarize(earlier.score);
  earlier.resultSha256 = digest(earlier.score);
  publishCandidate(host, candidate, earlier);
  const later = { ...structuredClone(raw), run: { ...run, attempt: 2 } };
  publishCandidate(host, candidate, later);
  process.env.GITHUB_RUN_ATTEMPT = "2";
  writeFileSync(rawPath, JSON.stringify(later));
  const regression = await foldQualification({ root: candidate.root, client, rawPath, output });
  assert.equal(regression.ok, false, "a later same-source attempt cannot erase an earlier gain");
  const retained = JSON.parse(readFileSync(resolve(output, "floor.json"), "utf8"));
  assert.equal(retained.floorIds.length, 4765);
  assert.deepEqual(retained.lostIds, [extra]);
  assert.ok(retained.floorIds.includes(extra));
  assert.deepEqual(oracleAt(candidate.root, bootstrap.sourceSha).identity, score.identity);
  assert.equal(raw.inputsSha256, digest(scoringInputs(candidate.root, candidate.sourceSha)));
}
test("real preparation, raw sealing and authenticated folding publish only the fresh source floor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(assertMainLifecycle);
});
test("forged foreign PRs, changed uploaders and expired receipt artifacts never recover a floor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(async (candidate) => {
    for (const mutate of [
      (host) => {
        host.values.get("json:/pulls/178").head.repo.id = 1;
      },
      (host) => {
        host.values.get(
          `json:/actions/workflows/${authority.workflowId}/runs?event=pull_request&head_sha=${record.landed[1].original.binding.headSha}&per_page=100`,
        ).workflow_runs[0].run_attempt++;
      },
      (host) => {
        host.values.get("json:/pulls/178").merge_commit_sha = sha(99);
      },
      (host) => {
        host.values.get("json:/actions/artifacts/12882357078").digest = `sha256:${"0".repeat(64)}`;
      },
      (host) => {
        host.values.get("json:/actions/artifacts/12882357078").expires_at = "2026-10-28T00:00:00Z";
      },
      (host) => {
        host.values.set("text:/actions/jobs/123333893573/logs", "forged uploader");
      },
      (host) => {
        host.values.get("json:/actions/runs/40832924721/attempts/2").event = "workflow_dispatch";
      },
      (host) => {
        host.values
          .get("json:/actions/runs/40841645539/attempts/1/jobs?per_page=100")
          .jobs.find((job) => job.name === "own-shell-observation")
          .steps.find(
            (step) => step.name === "Observe compatibility with the shared node build",
          ).conclusion = "success";
      },
    ]) {
      const host = hostFixture();
      mutate(host);
      await assert.rejects(
        prepareCandidate({ ...candidate, client: host.client, run: { runId: 1, attempt: 1 } }),
      );
    }
  });
});
async function assertPullRequestLifecycle(candidate) {
  const host = hostFixture();
  const { raw, rawPath, output } = await captureFixture(candidate, host);
  const result = await foldQualification({
    root: candidate.root,
    client: host.client,
    rawPath,
    output,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding, candidate.selected);
  assert.equal(result.floorSource.kind, "AcceptedGainFloor");
  assert.equal(result.floorSource.ids.length, 4764);
  assert.equal(raw.sourceSha, candidate.selected.testedMergeSha);
  assert.notEqual(raw.sourceSha, candidate.selected.headSha);
  assert.equal(
    existsSync(resolve(output, "floor.json")),
    false,
    "PR cannot publish main authority",
  );
}
test("tested PR merge qualifies against the fixed cut but never publishes a main observation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(async (candidate) => {
    const headSha = candidate.sourceSha;
    const tree = git(candidate.root, ["rev-parse", `${headSha}^{tree}`]);
    const sourceSha = git(candidate.root, [
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-p",
      terminalCut.sourceSha,
      "-p",
      headSha,
      "-m",
      "tested PR merge fixture",
    ]);
    git(candidate.root, ["update-ref", "HEAD", sourceSha]);
    const selected = {
      kind: "pull-request",
      headSha,
      testedMergeSha: sourceSha,
      baseSha: terminalCut.sourceSha,
      mainSha: terminalCut.sourceSha,
    };
    const pullRequest = { root: candidate.root, sourceSha, selected };
    await withQualificationEnvironment(pullRequest, () => assertPullRequestLifecycle(pullRequest));
  });
});
