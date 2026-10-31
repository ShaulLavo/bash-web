import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  prepareCandidate,
  foldCandidate,
  assertAcceptedFloor,
  assertAcceptedRaw,
} from "./shell-scoreboard-accepted-gains.ts";
import type {
  AcceptedRawScore,
  HistoricalAcceptedRawScore,
} from "./shell-scoreboard-accepted-gains.ts";
import {
  terminalCut,
  terminalRecord,
  assertTerminalRecord,
  assertTerminalCancelled,
  assertTerminalJobs,
  assertTerminalLanded,
  recomputeTerminalRequirement,
  assertTerminalFreshObservation,
} from "./shell-scoreboard-terminal-recovery.ts";
import type {
  TerminalContribution,
  TerminalContributionRecord,
  TerminalRequirementRecord,
} from "./shell-scoreboard-terminal-recovery.ts";
import {
  authority,
  git,
  oracleAt,
  resolveMainFloor,
  artifactJson,
  scoringInputs,
  assertArtifactListing,
  assertHostArtifact,
  assertHostRun,
  assertJobListing,
  assertPullRequest,
  assertRawScore,
} from "./shell-scoreboard-main.ts";
import type { GithubClient, HostArtifact, HostStep } from "./shell-scoreboard-main.ts";
import {
  bootstrap,
  qualification,
  compareFloor,
  assertMainFloor,
} from "./shell-scoreboard-floor.ts";
import { digest, bytesDigest, summarize, assertRecord } from "./shell-scoreboard.ts";
import type { Binding, MainPushBinding, PullRequestBinding, Score } from "./shell-scoreboard.ts";
import { prepareQualification, sealRaw, foldQualification } from "./scoreboard-ci.ts";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.ts";
const project = resolve(import.meta.dirname, "..");
const record: unknown = JSON.parse(readFileSync(resolve(project, terminalCut.recordPath), "utf8"));
assertTerminalRecord(record);
const sha = (number: number): string => number.toString(16).padStart(40, "0");
type StoredValue = Record<string, unknown> | Buffer | string;
type ResponseType = "json" | "bytes" | "text";
interface Candidate {
  root: string;
  sourceSha: string;
  selected: Binding;
}
interface MainCandidate extends Candidate {
  selected: MainPushBinding;
}
interface PullCandidate extends Candidate {
  selected: PullRequestBinding;
}
function hostFixture() {
  const responses: unknown = JSON.parse(
    gunzipSync(
      readFileSync(new URL("./test-data/terminal-floor-host.json.gz", import.meta.url)),
    ).toString("utf8"),
  );
  assert.ok(Array.isArray(responses));
  const values = new Map<string, StoredValue>();
  for (const response of responses) {
    assertRecord(response);
    assert.equal(typeof response.path, "string");
    assert.equal(typeof response.type, "string");
    if (response.type === "bytes") {
      assert.ok(typeof response.value === "string");
      values.set(`${response.type}:${response.path}`, Buffer.from(response.value, "base64"));
      continue;
    }
    if (response.type === "text") {
      assert.ok(typeof response.value === "string");
      values.set(`${response.type}:${response.path}`, response.value);
      continue;
    }
    assertRecord(response.value);
    values.set(`${response.type}:${response.path}`, response.value);
  }
  values.set("json:/git/ref/heads/main", { object: { sha: terminalCut.sourceSha } });
  function request(path: string, type: "bytes"): Promise<Buffer>;
  function request(path: string, type: "text"): Promise<string>;
  function request(path: string, type?: "json"): Promise<unknown>;
  async function request(path: string, type: ResponseType = "json"): Promise<unknown> {
    const key = `${type}:${path}`;
    const value = values.get(key);
    assert.ok(value !== undefined, `unexpected host request ${key}`);
    if (type === "bytes") {
      assert.ok(Buffer.isBuffer(value));
      return value;
    }
    if (type === "text") {
      assert.equal(typeof value, "string");
      return value;
    }
    return structuredClone(value);
  }
  const client: GithubClient = { request };
  return { values, client };
}
type HostFixture = ReturnType<typeof hostFixture>;
function hostJson(host: HostFixture, path: string): Record<string, unknown> {
  const value = host.values.get(`json:${path}`);
  assertRecord(value);
  return value;
}
function hostBytes(host: HostFixture, path: string): Buffer {
  const value = host.values.get(`bytes:${path}`);
  assert.ok(Buffer.isBuffer(value));
  return value;
}
async function withCandidate(body: (candidate: MainCandidate) => Promise<void>): Promise<void> {
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
    const selected: MainPushBinding = {
      kind: "main-push",
      sourceSha,
      beforeSha: terminalCut.sourceSha,
    };
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
    assert.ok(prepared.floor.kind === "AcceptedGainFloor");
    assert.equal(prepared.floor.base.sourceSha, terminalCut.baseSha);
    assert.equal(prepared.floor.ids.length, 4764);
    assert.equal(prepared.floor.floorSha256, record.requirement.floorSha256);
    assert.equal("sourceSha" in prepared.floor, false);
    assert.equal("score" in prepared.floor, false);
    for (const id of ["bashkit-suite:blackbox-edge-cases:232", "brush-suite:ifs:1"])
      assert.ok(prepared.floor.ids.includes(id));
    const score = scoreboardFixture("oils").score(["a"]);
    const raw: AcceptedRawScore = {
      schema: 1,
      kind: "raw-score",
      selected: prepared.selected,
      run: prepared.run,
      sourceSha: prepared.sourceSha,
      capturedAt: "2026-10-29T10:00:01Z",
      inputsSha256: "forged-preparation-control",
      resultSha256: digest(score),
      score,
      floor: prepared.floor,
    };
    await assert.rejects(foldCandidate(structuredClone(prepared), raw), /forged preparation/);
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
  const host = hostFixture();
  const get = (path: string): Record<string, unknown> => structuredClone(hostJson(host, path));
  const claim = record.cancelled[0];
  const run = get(`/actions/runs/${claim.runId}/attempts/1`);
  assertHostRun(run);
  const jobListing = get(`/actions/runs/${claim.runId}/attempts/1/jobs?per_page=100`);
  assertJobListing(jobListing);
  const jobs = jobListing.jobs;
  const artifactListing = get(`/actions/runs/${claim.runId}/artifacts?per_page=100`);
  assertArtifactListing(artifactListing);
  const artifacts = artifactListing.artifacts;
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
  assertPullRequest(pr);
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
  assertHostRun(originalRun);
  const originalJobListing = get(`/actions/runs/${originalRun.id}/attempts/2/jobs?per_page=100`);
  assertJobListing(originalJobListing);
  const originalJobs = originalJobListing.jobs;
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
  const entries: TerminalContribution[] = [sha(2), sha(3), sha(4)].map((mergeCommit, index) => {
    const binding: PullRequestBinding = {
      kind: "pull-request",
      headSha: sha(index + 10),
      testedMergeSha: sha(index + 20),
      baseSha: sha(1),
      mainSha: sha(1),
    };
    const addition = [["x"], ["y"], []][index];
    const score = fixture.score(["a"].concat(addition));
    const raw: HistoricalAcceptedRawScore = {
      schema: 1,
      kind: "raw-score",
      sourceSha: binding.testedMergeSha,
      selected: structuredClone(binding),
      run: { runId: index + 20, attempt: 2 },
      capturedAt: "2026-10-29T10:00:01Z",
      inputsSha256: digest(index),
      resultSha256: digest(score),
      score,
      floor: base,
    };
    const receipt = qualification(fixture.oracle, base, score, binding);
    const gains = Object.values(receipt.corpora)
      .flatMap((row) => row.gained)
      .sort();
    const contribution: TerminalContributionRecord = {
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
    return { record: contribution, raw, receipt };
  });
  const requirementRecord: TerminalRequirementRecord = {
    base: { sourceSha: base.sourceSha, run: base.run, floorSha256: base.floorSha256 },
    landed: entries.map((item) => item.record),
    requirement: { count: 3, floorSha256: digest(["a", "x", "y"]) },
  };
  return { fixture, base, record: requirementRecord, entries };
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
  ] satisfies ((
    value: Pick<ReturnType<typeof membershipFixture>, "record" | "entries">,
  ) => void)[]) {
    const value = structuredClone({ record, entries });
    mutate(value);
    assert.throws(() =>
      recomputeTerminalRequirement(fixture.oracle, value.record, base, value.entries),
    );
  }
});
function observationFixture() {
  const step = (name: string, number: number, start: string, end: string): HostStep => ({
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
    selected: {
      kind: "main-push",
      sourceSha: sha(1),
      beforeSha: sha(0),
    } satisfies MainPushBinding,
    capturedAt: "2026-10-29T10:00:01Z",
  };
  const jobs = ["own-shell-observation", "own-shell-compatibility"].map((name) => ({
    name,
    run_id: 10,
    run_attempt: 2,
    head_sha: sha(1),
    status: "completed",
    conclusion: "success",
    steps: Array<HostStep>(),
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
  assert.doesNotThrow(() =>
    assertTerminalFreshObservation(valid.raw, {
      observer: valid.jobs[0],
      sealer: valid.jobs[1],
      observerAttempt: 2,
    }),
  );
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
  ] satisfies ((value: ReturnType<typeof observationFixture>) => void)[]) {
    const value = observationFixture();
    mutate(value);
    assert.throws(() =>
      assertTerminalFreshObservation(value.raw, {
        observer: value.jobs[0],
        sealer: value.jobs[1],
        observerAttempt: 2,
      }),
    );
  }
});
type PublishRaw = Pick<AcceptedRawScore, "run" | "sourceSha" | "selected"> & {
  [key: string]: unknown;
};
function publishCandidate(host: HostFixture, candidate: Candidate, raw: PublishRaw): void {
  const runId = raw.run.runId;
  const attempt = raw.run.attempt;
  const pullRequest = candidate.selected.kind === "pull-request";
  const headSha =
    candidate.selected.kind === "pull-request" ? candidate.selected.headSha : candidate.sourceSha;
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
  const step = (
    name: string,
    number: number,
    started_at: string,
    completed_at: string,
  ): HostStep => ({
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
      step("Run actions/upload-artifact@v4", 3, "2026-10-29T10:01:00Z", "2026-10-29T10:01:01Z"),
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
  const observationInput = {
    sourceSha: candidate.sourceSha,
    selected: candidate.selected,
    run: { runId, attempt },
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "2026-10-29T10:00:01Z",
    inputsSha256: digest(scoringInputs(candidate.root, candidate.sourceSha)),
    floor: raw.floor,
  };
  const observationBytes = execFileSync(
    "python3",
    [
      "-c",
      "import io,json,sys,zipfile\nb=io.BytesIO();v=json.load(sys.stdin)\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('scoreboard-input.json',json.dumps(v['input'])); z.writestr('own-shell-current.json',json.dumps(v['score'])); z.writestr('own-shell-diagnostics/host.jsonl','diagnostics')\nsys.stdout.buffer.write(b.getvalue())",
    ],
    {
      input: JSON.stringify({ input: observationInput, score: raw.score }),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const observationArtifact: HostArtifact = {
    id: 200000 + attempt,
    name: `own-shell-current-${candidate.sourceSha}-${runId}-${attempt}`,
    digest: `sha256:${bytesDigest(observationBytes)}`,
    expired: false,
    created_at: "2026-10-29T10:01:00.500Z",
    expires_at: "2027-01-01T00:00:00Z",
    workflow_run: {
      id: runId,
      head_sha: headSha,
      head_repository_id: authority.repositoryId,
    },
  };
  const artifact: HostArtifact = {
    id: 100000 + attempt,
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
  const set = (path: string, value: StoredValue, type: ResponseType = "json"): void => {
    host.values.set(`${type}:${path}`, value);
  };
  set(`/actions/runs/${runId}/attempts/${attempt}`, run);
  set(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
    total_count: 2,
    jobs: [observer, sealer],
  });
  const existing = host.values.get(`json:/actions/runs/${runId}/artifacts?per_page=100`);
  if (existing !== undefined) assertRecord(existing);
  const previous = existing && Array.isArray(existing.artifacts) ? existing.artifacts : [];
  const artifacts = previous
    .filter((item) => {
      assertRecord(item);
      return item.id !== artifact.id && item.id !== observationArtifact.id;
    })
    .concat([observationArtifact, artifact]);
  set(`/actions/runs/${runId}/artifacts?per_page=100`, {
    total_count: artifacts.length,
    artifacts,
  });
  set(`/actions/artifacts/${observationArtifact.id}`, observationArtifact);
  set(`/actions/artifacts/${observationArtifact.id}/zip`, observationBytes, "bytes");
  set(
    `/actions/jobs/${observer.id}/logs`,
    `2026-10-29T10:01:00.600Z SHA256 digest of uploaded artifact zip is ${bytesDigest(observationBytes)}\n2026-10-29T10:01:00.700Z Artifact ${observationArtifact.name} has been successfully uploaded! Final size is ${observationBytes.length} bytes. Artifact ID is ${observationArtifact.id}\n`,
    "text",
  );
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
function currentScore(host: HostFixture): Score {
  const listing = hostJson(host, "/actions/runs/40841852105/artifacts?per_page=100");
  assert.ok(Array.isArray(listing.artifacts));
  const metadata = listing.artifacts.find((item) => {
    assertRecord(item);
    return item.id === 12883574814;
  });
  assertHostArtifact(metadata);
  const raw = artifactJson(
    hostBytes(host, "/actions/artifacts/12883574814/zip"),
    metadata,
    "raw.json",
  );
  assertRawScore(raw);
  return raw.score;
}
async function withQualificationEnvironment(
  candidate: Candidate,
  body: () => Promise<void>,
): Promise<void> {
  const eventPath = resolve(candidate.root, "event.json");
  const repository = { id: authority.repositoryId };
  let event;
  if (candidate.selected.kind === "pull-request") {
    event = {
      repository,
      pull_request: {
        head: { sha: candidate.selected.headSha },
        base: { ref: "main", sha: candidate.selected.baseSha, repo: repository },
      },
    };
  } else {
    event = {
      repository,
      ref: "refs/heads/main",
      after: candidate.sourceSha,
      before: candidate.selected.beforeSha,
    };
  }
  writeFileSync(eventPath, JSON.stringify(event));
  const environment = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: candidate.selected.kind === "pull-request" ? "pull_request" : "push",
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
async function assertMainLifecycle(candidate: MainCandidate): Promise<void> {
  await withQualificationEnvironment(candidate, () => runMainLifecycle(candidate));
}
async function captureFixture(candidate: Candidate, host: HostFixture) {
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
  const capture: unknown = JSON.parse(readFileSync(prepared, "utf8"));
  assertRecord(capture);
  assertAcceptedFloor(capture.floor);
  assert.equal(capture.floor.kind, "AcceptedGainFloor");
  assert.equal(capture.floor.ids.length, 4764);
  writeFileSync(scorePath, JSON.stringify(score));
  sealRaw({ root: candidate.root, input: prepared, scorePath, output: rawDir });
  const rawPath = resolve(rawDir, "raw.json");
  const raw: unknown = JSON.parse(readFileSync(rawPath, "utf8"));
  assertAcceptedRaw(raw);
  publishCandidate(host, candidate, raw);
  return { raw, rawPath, output, score, run };
}
async function runMainLifecycle(candidate: MainCandidate): Promise<void> {
  const host = hostFixture();
  const { client } = host;
  const { raw, rawPath, output, score, run } = await captureFixture(candidate, host);
  const result = await foldQualification({ root: candidate.root, client, rawPath, output });
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding, candidate.selected);
  const floor: unknown = JSON.parse(readFileSync(resolve(output, "floor.json"), "utf8"));
  assertMainFloor(floor);
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
    const removedCase = changed.score.cases.find((row) => row.id === removed);
    assert.ok(removedCase);
    removedCase.outcome = "fail";
    changed.score.counts = summarize(changed.score);
    changed.resultSha256 = digest(changed.score);
    publishCandidate(host, candidate, changed);
    writeFileSync(rawPath, JSON.stringify(changed));
    await assert.rejects(
      foldQualification({ root: candidate.root, client, rawPath, output }),
      /accepted passing IDs were lost/,
    );
  }
  const extraCase = score.cases.find(
    (row) => row.kind === "builtins-only" && !row.excluded && row.outcome === "fail",
  );
  assert.ok(extraCase);
  const extra = extraCase.id;
  const earlier = structuredClone(raw);
  const earlierCase = earlier.score.cases.find((row) => row.id === extra);
  assert.ok(earlierCase);
  earlierCase.outcome = "pass";
  earlier.score.counts = summarize(earlier.score);
  earlier.resultSha256 = digest(earlier.score);
  publishCandidate(host, candidate, earlier);
  const later = {
    ...structuredClone(raw),
    run: { ...run, attempt: 2 },
    observationRun: { ...run, attempt: 2 },
  };
  publishCandidate(host, candidate, later);
  process.env.GITHUB_RUN_ATTEMPT = "2";
  writeFileSync(rawPath, JSON.stringify(later));
  const regression = await foldQualification({ root: candidate.root, client, rawPath, output });
  assert.equal(regression.ok, false, "a later same-source attempt cannot erase an earlier gain");
  const retained: unknown = JSON.parse(readFileSync(resolve(output, "floor.json"), "utf8"));
  assertMainFloor(retained);
  assert.equal(retained.floorIds.length, 4765);
  assert.deepEqual(retained.lostIds, [extra]);
  assert.ok(retained.floorIds.includes(extra));
  assert.deepEqual(oracleAt(candidate.root, bootstrap.sourceSha).identity, score.identity);
  assert.equal(raw.inputsSha256, digest(scoringInputs(candidate.root, candidate.sourceSha)));
}
function removeArtifact(host: HostFixture, artifact: Record<string, unknown>): void {
  const id = artifact.id;
  assert.equal(typeof id, "number");
  host.values.delete(`json:/actions/artifacts/${id}`);
  host.values.delete(`bytes:/actions/artifacts/${id}/zip`);
}
function publishFailedJobsRerun(
  host: HostFixture,
  candidate: Candidate,
  raw: AcceptedRawScore,
  rawPath: string,
): AcceptedRawScore {
  process.env.GITHUB_RUN_ATTEMPT = "2";
  sealRaw({
    root: candidate.root,
    input: resolve(candidate.root, "prepared.json"),
    scorePath: resolve(candidate.root, "score.json"),
    output: resolve(candidate.root, "raw"),
  });
  const later: unknown = JSON.parse(readFileSync(rawPath, "utf8"));
  assertAcceptedRaw(later);
  assert.deepEqual(later.observationRun, raw.run);
  publishCandidate(host, candidate, later);
  const jobs = hostJson(host, `/actions/runs/${later.run.runId}/attempts/2/jobs?per_page=100`);
  assertJobListing(jobs);
  jobs.jobs = jobs.jobs.filter((job) => job.name !== "own-shell-observation");
  jobs.total_count = jobs.jobs.length;
  const listing = hostJson(host, `/actions/runs/${later.run.runId}/artifacts?per_page=100`);
  const artifacts = listing.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("missing artifact listing");
  const current = artifacts.find((item) => {
    assertRecord(item);
    return item.name === `own-shell-current-${candidate.sourceSha}-${later.run.runId}-2`;
  });
  assertRecord(current);
  removeArtifact(host, current);
  listing.artifacts = artifacts.filter((item) => item !== current);
  listing.total_count = artifacts.length - 1;
  writeFileSync(rawPath, JSON.stringify(later));
  return later;
}
interface AcceptedRerunFixture {
  host: HostFixture;
  rawPath: string;
  output: string;
  later: AcceptedRawScore;
}
async function acceptedRerunFixture(candidate: Candidate): Promise<AcceptedRerunFixture> {
  const host = hostFixture();
  const { rawPath, output, raw } = await captureFixture(candidate, host);
  const later = publishFailedJobsRerun(host, candidate, raw, rawPath);
  process.env.GITHUB_RUN_ATTEMPT = "2";
  return { host, rawPath, output, later };
}
async function foldAcceptedRerun(
  candidate: Candidate,
  fixture: AcceptedRerunFixture,
): Promise<Awaited<ReturnType<typeof foldQualification>>> {
  const result = await foldQualification({
    root: candidate.root,
    client: fixture.host.client,
    rawPath: fixture.rawPath,
    output: fixture.output,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding, candidate.selected);
  assert.equal(fixture.later.run.attempt, 2);
  return result;
}
test("accepted-floor recovery binds an earlier observation artifact to its own attempt on a failed-jobs rerun", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(async (candidate) => {
    await withQualificationEnvironment(candidate, async () => {
      await foldAcceptedRerun(candidate, await acceptedRerunFixture(candidate));
    });
  });
});
async function rejectForeignObservation(
  candidate: Candidate,
  mutate: (artifact: Record<string, unknown>) => void,
): Promise<void> {
  await withQualificationEnvironment(candidate, async () => {
    const fixture = await acceptedRerunFixture(candidate);
    const listing = hostJson(
      fixture.host,
      `/actions/runs/${fixture.later.run.runId}/artifacts?per_page=100`,
    );
    assert.ok(Array.isArray(listing.artifacts));
    const observation = listing.artifacts.find((item) => {
      assertRecord(item);
      return item.name === `own-shell-current-${candidate.sourceSha}-${fixture.later.run.runId}-1`;
    });
    assertRecord(observation);
    mutate(observation);
    await assert.rejects(
      foldAcceptedRerun(candidate, fixture),
      /wrong artifact run|wrong artifact source|uploader digest differs/,
    );
  });
}
test("accepted-floor reruns reject observation artifacts from another run or commit, or with a changed digest", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  for (const mutate of [
    (artifact: Record<string, unknown>) => {
      const workflowRun = artifact.workflow_run;
      assertRecord(workflowRun);
      workflowRun.id = 12;
    },
    (artifact: Record<string, unknown>) => {
      const workflowRun = artifact.workflow_run;
      assertRecord(workflowRun);
      workflowRun.head_sha = sha(99);
    },
    (artifact: Record<string, unknown>) => {
      artifact.digest = `sha256:${"0".repeat(64)}`;
    },
  ]) {
    await withCandidate((candidate) => rejectForeignObservation(candidate, mutate));
  }
});
test("real preparation, raw sealing and authenticated folding publish only the fresh source floor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(assertMainLifecycle);
});
test("forged foreign PRs, changed uploaders and expired receipt artifacts never recover a floor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T10:00:01Z") });
  await withCandidate(async (candidate) => {
    for (const mutate of [
      (host) => {
        const pr = hostJson(host, "/pulls/178");
        assertRecord(pr.head);
        assertRecord(pr.head.repo);
        pr.head.repo.id = 1;
      },
      (host) => {
        const runs = hostJson(
          host,
          `/actions/workflows/${authority.workflowId}/runs?event=pull_request&head_sha=${record.landed[1].original.binding.headSha}&per_page=100`,
        );
        assert.ok(Array.isArray(runs.workflow_runs));
        const first = runs.workflow_runs[0];
        assertRecord(first);
        assert.ok(typeof first.run_attempt === "number");
        first.run_attempt++;
      },
      (host) => {
        hostJson(host, "/pulls/178").merge_commit_sha = sha(99);
      },
      (host) => {
        hostJson(host, "/actions/artifacts/12882357078").digest = `sha256:${"0".repeat(64)}`;
      },
      (host) => {
        hostJson(host, "/actions/artifacts/12882357078").expires_at = "2026-10-28T00:00:00Z";
      },
      (host) => {
        host.values.set("text:/actions/jobs/123333893573/logs", "forged uploader");
      },
      (host) => {
        hostJson(host, "/actions/runs/40832924721/attempts/2").event = "workflow_dispatch";
      },
      (host) => {
        const listing = hostJson(host, "/actions/runs/40841645539/attempts/1/jobs?per_page=100");
        assert.ok(Array.isArray(listing.jobs));
        const job = listing.jobs.find((value) => {
          assertRecord(value);
          return value.name === "own-shell-observation";
        });
        assertRecord(job);
        assert.ok(Array.isArray(job.steps));
        const step = job.steps.find((value) => {
          assertRecord(value);
          return value.name === "Observe compatibility with the shared node build";
        });
        assertRecord(step);
        step.conclusion = "success";
      },
    ] satisfies ((host: HostFixture) => void)[]) {
      const host = hostFixture();
      mutate(host);
      await assert.rejects(
        prepareCandidate({ ...candidate, client: host.client, run: { runId: 1, attempt: 1 } }),
      );
    }
  });
});
async function assertPullRequestLifecycle(candidate: PullCandidate): Promise<void> {
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
  assertAcceptedFloor(result.floorSource);
  assert.equal(result.floorSource.kind, "AcceptedGainFloor");
  assert.equal(result.floorSource.ids.length, 4764);
  assert.equal(raw.sourceSha, candidate.selected.testedMergeSha);
  assert.notEqual(raw.sourceSha, candidate.selected.headSha);
  assert.equal(
    existsSync(resolve(output, "floor.json")),
    false,
    "PR cannot publish main authority",
  );
  await foldAcceptedRerun(candidate, await acceptedRerunFixture(candidate));
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
    const selected: PullRequestBinding = {
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
