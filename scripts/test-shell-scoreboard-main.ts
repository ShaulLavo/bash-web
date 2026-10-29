import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  admitQualificationRaw,
  assertMainRun,
  assertUploader,
  artifactJson,
  authority,
  firstParent,
  git,
  mainEvidence,
  oracleAt,
  resolveFloor,
  scoringInputs,
  sourceEquivalent,
} from "./shell-scoreboard-main.ts";
import { bootstrap } from "./shell-scoreboard-floor.ts";
import { bytesDigest, digest, summarize } from "./shell-scoreboard.ts";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.ts";
import {
  foldQualification,
  prepareQualification,
  sealRaw,
  selectBaseline,
  verifyBinding,
} from "./scoreboard-ci.ts";

const sha = (n) => n.toString(16).padStart(40, "0");
const fixture = scoreboardFixture("oils");
const { oracle } = fixture;
const score = (ids) => fixture.score(ids, true);
const floor = (sourceSha, ids) => fixture.floor(ids, sourceSha);
const twoEdges = () =>
  new Map([
    [sha(2), sha(1)],
    [sha(1), bootstrap.sourceSha],
  ]);
const empty = () => ({ scores: [], floors: [], evidence: [] });
function provenance(kind = "raw") {
  const jobName = kind === "raw" ? "own-shell-compatibility" : "score-floor";
  const observe = kind === "raw" ? "Seal complete raw score" : "Fold main floor and qualification";
  const upload = kind === "raw" ? "Upload complete raw score" : "Upload cumulative main floor";
  const name = `own-shell-${kind}-${sha(1)}-10-2`;
  const start = "2026-10-24T17:00:00Z",
    end = "2026-10-24T17:00:02Z";
  const run = {
    id: 10,
    run_attempt: 2,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    head_sha: sha(1),
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    event: "push",
    head_branch: "main",
    status: "in_progress",
    conclusion: null,
  };
  const job = {
    id: 20,
    name: jobName,
    run_id: 10,
    run_attempt: 2,
    head_sha: sha(1),
    status: "completed",
    conclusion: "success",
    steps: [observe, upload].map((step, i) => ({
      name: step,
      number: i + 1,
      status: "completed",
      conclusion: "success",
      started_at: start,
      completed_at: end,
    })),
  };
  const artifact = {
    id: 30,
    name,
    workflow_run: { id: 10, head_sha: sha(1), head_repository_id: authority.repositoryId },
    expired: false,
    digest: `sha256:${"d".repeat(64)}`,
    created_at: start,
  };
  const logs = `2026-10-24T17:00:01.100Z SHA256 digest of uploaded artifact zip is ${"d".repeat(64)}\n2026-10-24T17:00:01.200Z Artifact ${name} has been successfully uploaded! Final size is 100 bytes. Artifact ID is 30\n`;
  return {
    kind,
    run,
    job,
    artifact,
    logs,
    workflow: readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  };
}
test("a completed producer is admissible while its workflow/aggregate/floor job remain running", () => {
  const input = provenance();
  assertMainRun(input.run, sha(1), 2);
  assert.equal(assertUploader(input).jobId, 20);
  for (const status of ["in_progress", "queued"]) {
    input.run.status = status;
    assert.doesNotThrow(() => assertUploader(input));
  }
});
test("host main provenance rejects PR/manual, wrong repo/workflow/path/source/attempt", () => {
  for (const patch of [
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { head_sha: sha(2) },
    { workflow_id: 4 },
    { path: "other.yml" },
    { run_attempt: 1 },
    { repository: { id: 1 } },
    { head_repository: { id: 1 } },
  ]) {
    const input = provenance();
    assert.throws(() => assertMainRun({ ...input.run, ...patch }, sha(1), 2));
  }
});
test("unfinished/cancelled producers and another job or attempt cannot qualify", () => {
  for (const patch of [
    { name: "quality" },
    { run_id: 11 },
    { run_attempt: 1 },
    { head_sha: sha(2) },
    { status: "in_progress" },
    { conclusion: "cancelled" },
    { conclusion: "failure" },
  ]) {
    const input = provenance();
    assert.throws(() => assertUploader({ ...input, job: { ...input.job, ...patch } }));
  }
  for (const conclusion of ["failure", "skipped", "cancelled", null]) {
    const input = provenance();
    input.job.steps[1].conclusion = conclusion;
    assert.throws(() => assertUploader(input));
  }
});
test("artifact ID/digest/upload-window and unique reviewed uploader are host-bound", () => {
  for (const patch of [
    { name: `own-shell-raw-${sha(1)}-10-1` },
    { id: 3 },
    { digest: `sha256:${"e".repeat(64)}` },
    { created_at: "2026-10-23T17:00:00Z" },
    { expired: true },
    { workflow_run: { id: 11, head_sha: sha(1), head_repository_id: authority.repositoryId } },
  ]) {
    const input = provenance();
    assert.throws(() => assertUploader({ ...input, artifact: { ...input.artifact, ...patch } }));
  }
  const input = provenance();
  assert.throws(() => assertUploader({ ...input, logs: "self-claimed jobId:20 artifactId:30" }));
  assert.throws(() =>
    assertUploader({
      ...input,
      workflow: input.workflow.replace(
        "      - name: Upload complete raw score",
        "      - name: Fake upload",
      ),
    }),
  );
  assert.throws(() =>
    assertUploader({
      ...input,
      workflow: input.workflow
        .replace(
          "      - name: Upload gained and lost IDs",
          "      - name: Upload complete raw score",
        )
        .replace("name: own-shell-qualification-${{", "name: own-shell-raw-${{"),
    }),
  );
});
test("a successfully uploaded regression receipt stays authoritative, never green", () => {
  const input = provenance("floor");
  input.job.conclusion = "failure";
  input.job.steps.push({
    name: "Enforce qualification",
    number: 3,
    status: "completed",
    conclusion: "failure",
  });
  assert.doesNotThrow(() => assertUploader(input));
  input.job.steps[2].name = "Some broken validation";
  assert.throws(() => assertUploader(input), /unexpected failed producer/);
});
function archive(entries) {
  return execFileSync(
    "python3",
    [
      "-c",
      "import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [z.writestr(n,v) for n,v in json.load(sys.stdin)]; z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    {
      input: JSON.stringify(entries),
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}
test("archive digests, fixed members and duplicates/path traversal fail closed", () => {
  const bytes = archive([["raw.json", '{"schema":1}']]);
  const artifact = { digest: `sha256:${bytesDigest(bytes)}` };
  assert.deepEqual(artifactJson(bytes, artifact, "raw.json"), { schema: 1 });
  assert.throws(
    () => artifactJson(bytes, { digest: `sha256:${"0".repeat(64)}` }, "raw.json"),
    /digest/,
  );
  for (const entries of [
    [
      ["raw.json", "{}"],
      ["raw.json", "{}"],
    ],
    [["../raw.json", "{}"]],
    [
      ["raw.json", "{}"],
      ["extra", "x"],
    ],
  ]) {
    const bad = archive(entries);
    assert.throws(() => artifactJson(bad, { digest: `sha256:${bytesDigest(bad)}` }, "raw.json"));
  }
});
async function resolution(sourceSha, records, parents, same = () => false) {
  return resolveFloor({
    oracle,
    sourceSha,
    collect: async (sha) => records.get(sha) ?? empty(),
    parent: (sha) => parents.get(sha),
    equivalent: (before, source) => ({
      equivalent: same(before, source),
      beforeInputsSha256: digest(before),
      sourceInputsSha256: digest(source),
    }),
    anchor: async () => floor(bootstrap.sourceSha, ["a"]),
  });
}
test("first deployment PR consumes only bootstrap; first main uses its predecessor, not its own floor", async () => {
  const records = new Map();
  const parents = new Map([[sha(1), bootstrap.sourceSha]]);
  assert.deepEqual((await resolution(bootstrap.sourceSha, records, parents)).floorIds, ["a"]);
  records.set(sha(1), { ...empty(), scores: [score(["a", "x"])] });
  assert.deepEqual((await resolution(sha(1), records, parents)).floorIds, ["a", "x"]);
});
test("all admitted same-source raw attempts and receipts union; newest cannot erase old gains", async () => {
  const records = new Map([
    [sha(1), { ...empty(), floors: [floor(sha(1), ["a", "x"])], scores: [score(["a", "y"])] }],
  ]);
  assert.deepEqual((await resolution(sha(1), records, new Map())).floorIds, ["a", "x", "y"]);
});
test("cancelled docs-only edges bridge, non-equivalent gaps block without any replay", async () => {
  const parents = twoEdges();
  assert.deepEqual((await resolution(sha(2), new Map(), parents, () => true)).floorIds, ["a"]);
  await assert.rejects(
    resolution(sha(2), new Map(), parents, (before) => before !== bootstrap.sourceSha),
    /missing-non-equivalent-main-score.*0001/,
  );
});
test("each feature/revert edge contributes even when endpoints are equivalent", async () => {
  const parents = twoEdges();
  const records = new Map([
    [sha(2), { ...empty(), scores: [score(["a"])] }],
    [sha(1), { ...empty(), scores: [score(["a", "x"])] }],
  ]);
  assert.deepEqual((await resolution(sha(2), records, parents)).floorIds, ["a", "x"]);
  records.delete(sha(1));
  await assert.rejects(resolution(sha(2), records, parents), /missing-non-equivalent-main-score/);
});
test("out-of-order raw publication needs only another cheap fold, not producer reruns", async () => {
  const parents = twoEdges();
  const records = new Map([[sha(2), { ...empty(), scores: [score(["a", "y"])] }]]);
  await assert.rejects(resolution(sha(2), records, parents), /prerequisite/);
  records.set(sha(1), { ...empty(), scores: [score(["a", "x"])] });
  assert.deepEqual((await resolution(sha(2), records, parents)).floorIds, ["a", "x", "y"]);
});
test("resolution stops at 32 edges without a history replay or static fallback", async () => {
  let visited = 0;
  await assert.rejects(
    resolveFloor({
      oracle,
      sourceSha: sha(99),
      collect: async () => {
        visited++;
        return empty();
      },
      parent: (value) => sha(Number.parseInt(value, 16) - 1),
      equivalent: () => ({
        equivalent: true,
        beforeInputsSha256: digest("same"),
        sourceInputsSha256: digest("same"),
      }),
      anchor: async () => {
        throw new Error("must not reseed");
      },
    }),
    /floor-gap-too-wide/,
  );
  assert.equal(visited, 33);
});
async function withRepo(body) {
  const root = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "scoreboard-git-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Score fixture"]);
    git(root, ["config", "user.email", "score@example.invalid"]);
    const put = (path, value) => {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(resolve(root, path), value);
    };
    const commit = () => {
      git(root, ["add", "."]);
      git(root, [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "maintenance.auto=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      return git(root, ["rev-parse", "HEAD"]);
    };
    await body({ root, put, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}
test("complete input equivalence excludes only reviewed regular docs, never adapter/lock/config changes", async () => {
  await withRepo(({ root, put, commit }) => {
    put("src/runtime/worker.ts", "a");
    put("package-lock.json", "a");
    const base = commit();
    put("docs/guide.md", "documentation");
    const docs = commit();
    assert.equal(sourceEquivalent(root, base, docs), true);
    assert.equal(firstParent(root, docs), base);
    put("src/runtime/worker.ts", "b");
    const changed = commit();
    assert.equal(sourceEquivalent(root, base, changed), false);
    assert.notDeepEqual(scoringInputs(root, base), scoringInputs(root, changed));
  });
});
function pullRequestProvenance(headSha, baseSha) {
  return {
    event: {
      repository: { id: authority.repositoryId },
      pull_request: {
        head: { sha: headSha },
        base: { sha: baseSha, ref: "main", repo: { id: authority.repositoryId } },
      },
    },
    run: {
      repository: { id: authority.repositoryId },
      workflow_id: authority.workflowId,
      path: authority.workflowPath,
      event: "pull_request",
      head_sha: headSha,
    },
  };
}
test("H/C/B/M are distinct and actual merge parents/current main inclusion are checked", async () => {
  await withRepo(({ root, put, commit }) => {
    put("src/runtime/worker.ts", "a");
    const baseSha = commit();
    git(root, ["checkout", "-qb", "feature"]);
    put("feature.txt", "x");
    const headSha = commit();
    git(root, ["checkout", "--detach", baseSha]);
    put("docs/guide.md", "docs");
    const mainSha = commit();
    git(root, ["checkout", "--detach", baseSha]);
    git(root, [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.auto=false",
      "merge",
      "--no-ff",
      "-m",
      "synthetic",
      headSha,
    ]);
    const sourceSha = git(root, ["rev-parse", "HEAD"]);
    const { event, run } = pullRequestProvenance(headSha, baseSha);
    const input = { root, event, eventName: "pull_request", sourceSha, mainSha, run };
    assert.deepEqual(verifyBinding(input), {
      kind: "pull-request",
      headSha,
      testedMergeSha: sourceSha,
      baseSha,
      mainSha,
    });
    assert.throws(() =>
      verifyBinding({
        ...input,
        event: { ...event, pull_request: { ...event.pull_request, head: { sha: mainSha } } },
      }),
    );
    assert.throws(() =>
      verifyBinding({ ...input, mainSha: headSha, run: { ...run, head_sha: mainSha } }),
    );
    git(root, ["checkout", "--detach", mainSha]);
    put("src/runtime/worker.ts", "changed main");
    const changedMain = commit();
    git(root, ["checkout", "--detach", sourceSha]);
    assert.throws(
      () => verifyBinding({ ...input, mainSha: changedMain }),
      /not included or scoring-equivalent/,
    );
  });
});

function rebuiltMerge({ root, put, commit }) {
  put("source.txt", "base");
  const eventBase = commit();
  git(root, ["checkout", "-qb", "feature"]);
  put("feature.txt", "head");
  const headSha = commit();
  git(root, ["checkout", "--detach", eventBase]);
  put("main.txt", "new main");
  const mainSha = commit();
  git(root, ["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "rebuilt", headSha]);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const { event, run } = pullRequestProvenance(headSha, eventBase);
  run.pull_requests = [{ head: { sha: headSha }, base: { sha: eventBase } }];
  return { root, event, eventName: "pull_request", sourceSha, mainSha, run };
}
test("a rebuilt tested merge binds its main parent rather than the stale PR event base", async () => {
  await withRepo((repo) => {
    const input = rebuiltMerge(repo);
    const headSha = input.run.head_sha;
    assert.deepEqual(verifyBinding(input), {
      kind: "pull-request",
      headSha,
      testedMergeSha: input.sourceSha,
      baseSha: input.mainSha,
      mainSha: input.mainSha,
    });
    assert.equal(selectBaseline(input), input.mainSha);
  });
});

test("rebuilt merge validation rejects wrong heads, unrelated or invalid bases, and forged topology", async () => {
  await withRepo((repo) => {
    const input = rebuiltMerge(repo);
    const { root, event, sourceSha, mainSha, run } = input;
    const wrongHead = { ...event, pull_request: { ...event.pull_request, head: { sha: mainSha } } };
    assert.throws(
      () => verifyBinding({ ...input, event: wrongHead, run: { ...run, head_sha: mainSha } }),
      /second parent differs/,
    );
    const unrelated = git(root, ["commit-tree", `${mainSha}^{tree}`, "-m", "unrelated"]);
    for (const base of [unrelated, run.head_sha, "f".repeat(40), "not-a-sha"]) {
      const invalid = {
        ...event,
        pull_request: { ...event.pull_request, base: { ...event.pull_request.base, sha: base } },
      };
      assert.throws(() => verifyBinding({ ...input, event: invalid }));
      assert.throws(() => selectBaseline({ ...input, event: invalid }));
    }
    assert.throws(
      () => verifyBinding({ ...input, mainSha: run.head_sha }),
      /captured main history/,
    );
    const forged = [
      [unrelated, run.head_sha],
      [run.head_sha, mainSha],
      [mainSha, run.head_sha, unrelated],
    ];
    for (const parents of forged) {
      const args = ["commit-tree", `${sourceSha}^{tree}`, "-m", "forged"].concat(
        parents.flatMap((sha) => ["-p", sha]),
      );
      const commit = git(root, args);
      git(root, ["checkout", "--detach", commit]);
      assert.throws(() => verifyBinding({ ...input, sourceSha: commit }));
    }
    git(root, ["checkout", "--detach", run.head_sha]);
    assert.throws(() => verifyBinding({ ...input, sourceSha: run.head_sha }), /two-parent merge/);
  });
});

function hostedArtifact({
  root,
  sourceSha,
  attempt,
  kind,
  passes,
  status = "completed",
  observation = score(passes),
  requiredFloor = floor(sourceSha, passes),
}) {
  const input = provenance(kind);
  Object.assign(input.run, { head_sha: sourceSha, run_attempt: attempt });
  Object.assign(input.job, { head_sha: sourceSha, run_attempt: attempt, id: 20 + attempt, status });
  const raw = {
    schema: 1,
    kind: "raw-score",
    sourceSha,
    selected: { kind: "main-push", sourceSha, beforeSha: bootstrap.sourceSha },
    run: { runId: input.run.id, attempt },
    inputsSha256: digest(scoringInputs(root, sourceSha)),
    resultSha256: digest(observation),
    score: observation,
  };
  const payload =
    kind === "raw"
      ? raw
      : {
          ...requiredFloor,
          run: raw.run,
          beforeSha: bootstrap.sourceSha,
          lostIds: [],
        };
  const bytes = archive([[`${kind === "raw" ? "raw" : "floor"}.json`, JSON.stringify(payload)]]);
  Object.assign(input.artifact, {
    id: 100 + attempt * 2 + Number(kind === "floor"),
    name: `own-shell-${kind}-${sourceSha}-10-${attempt}`,
    digest: `sha256:${bytesDigest(bytes)}`,
    workflow_run: { id: 10, head_sha: sourceSha, head_repository_id: authority.repositoryId },
  });
  input.logs = `2026-10-24T17:00:01.100Z SHA256 digest of uploaded artifact zip is ${bytesDigest(bytes)}\n2026-10-24T17:00:01.200Z Artifact ${input.artifact.name} has been successfully uploaded! Final size is ${bytes.length} bytes. Artifact ID is ${input.artifact.id}\n`;
  return { ...input, payload, bytes };
}
function hostedObservation({ root, sourceSha, attempt = 1, passes = ["a", "x"] }) {
  const beforeSha = git(root, ["rev-parse", `${sourceSha}^`]);
  const start = "2026-10-24T17:00:00Z";
  const step = (name, number, startedAt = start, completedAt = "2026-10-24T17:00:02Z") => ({
    name,
    number,
    status: "completed",
    conclusion: "success",
    started_at: startedAt,
    completed_at: completedAt,
  });
  const run = {
    id: 10,
    run_attempt: attempt,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    head_sha: sourceSha,
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "failure",
  };
  const jobs = [
    { id: 11, name: "prepare", status: "completed", conclusion: "success" },
    { id: 12, name: "own-shell-scoreboard", status: "completed", conclusion: "failure" },
    {
      id: 13,
      name: "own-shell-observation",
      run_id: run.id,
      run_attempt: attempt,
      head_sha: sourceSha,
      status: "completed",
      conclusion: "success",
      steps: [
        step(
          "Bind qualification and resolve PR main floor",
          7,
          "2026-10-24T17:00:00Z",
          "2026-10-24T17:00:02Z",
        ),
        step(
          "Observe compatibility with the shared node build",
          10,
          "2026-10-24T17:00:03Z",
          "2026-10-24T17:00:04Z",
        ),
        step("Run actions/upload-artifact@v4", 11, "2026-10-24T17:00:04Z", "2026-10-24T17:00:05Z"),
      ],
    },
    { id: 14, name: "own-shell-compatibility", status: "completed", conclusion: "skipped" },
  ];
  for (const job of jobs) {
    job.run_id = run.id;
    job.run_attempt = attempt;
    job.head_sha = sourceSha;
    job.steps ??= [];
  }
  const input = {
    selected: { kind: "main-push", sourceSha, beforeSha },
    sourceSha,
    capturedAt: "2026-10-24T17:00:01.500Z",
    run: { runId: run.id, attempt },
    floor: null,
    inputsSha256: digest(scoringInputs(root, sourceSha)),
  };
  const scoreValue = score(passes);
  const artifact = {
    id: 101,
    name: `own-shell-current-${sourceSha}-${run.id}-${attempt}`,
    workflow_run: { id: run.id, head_sha: sourceSha, head_repository_id: authority.repositoryId },
    expired: false,
    digest: "",
    created_at: "2026-10-24T17:00:04.500Z",
  };
  const result = {
    run,
    jobs,
    artifacts: [artifact],
    artifact,
    input,
    score: scoreValue,
    workflow: readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    refresh() {
      const entries = [["scoreboard-input.json", JSON.stringify(this.input)]].concat(
        this.omitScore ? [] : [["own-shell-current.json", JSON.stringify(this.score)]],
        [["own-shell-diagnostics/host.jsonl", "diagnostics"]],
        this.extraMembers ?? [],
      );
      const bytes = archive(entries);
      this.bytes = bytes;
      this.artifact.digest = `sha256:${bytesDigest(bytes)}`;
      this.logsByJobId ??= {};
      this.logsByJobId[13] =
        this.logOverride ??
        `2026-10-24T17:00:04.600Z SHA256 digest of uploaded artifact zip is ${bytesDigest(bytes)}\n2026-10-24T17:00:04.700Z Artifact ${this.artifact.name} has been successfully uploaded! Final size is ${bytes.length} bytes. Artifact ID is ${this.artifact.id}\n`;
    },
  };
  result.refresh();
  return result;
}
function hostedClient(sourceSha, inputs) {
  const runId = inputs[0].run.id;
  const requests = [];
  const jobs = inputs.flatMap((item) => item.jobs ?? [item.job]);
  const artifacts = inputs.flatMap((item) => item.artifacts ?? [item.artifact]);
  const logs = new Map(
    inputs.flatMap((item) =>
      (item.jobs ?? [item.job]).map((job) => [job.id, item.logsByJobId?.[job.id] ?? item.logs]),
    ),
  );
  const bytes = new Map(
    inputs.flatMap((item) =>
      (item.artifacts ?? [item.artifact]).map((artifact) => [
        artifact.id,
        item.bytesByArtifact?.[artifact.id] ?? item.bytes,
      ]),
    ),
  );
  async function request(path) {
    requests.push(path);
    if (path.startsWith(`/actions/workflows/${authority.workflowId}/runs?`))
      return {
        total_count: 1,
        workflow_runs: [
          { id: runId, run_attempt: Math.max(...inputs.map((item) => item.run.run_attempt)) },
        ],
      };
    if (path === `/actions/runs/${runId}/artifacts?per_page=100`)
      return { total_count: artifacts.length, artifacts };
    const attempt = path.match(
      new RegExp(`^/actions/runs/${runId}/attempts/(\\d+)(/jobs\\?per_page=100)?$`),
    );
    if (attempt) {
      const selected = inputs.filter((item) => item.run.run_attempt === Number(attempt[1]));
      if (attempt[2])
        return {
          total_count: selected.reduce(
            (count, item) => count + (item.jobs ?? [item.job]).length,
            0,
          ),
          jobs: jobs.filter((job) =>
            selected.some((item) => (item.jobs ?? [item.job]).includes(job)),
          ),
        };
      return selected[0]?.run;
    }
    const log = path.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (log && logs.has(Number(log[1]))) return logs.get(Number(log[1]));
    const artifact = path.match(/^\/actions\/artifacts\/(\d+)\/zip$/);
    if (artifact && bytes.has(Number(artifact[1]))) return bytes.get(Number(artifact[1]));
    throw new Error(`unexpected host request ${path} at ${sourceSha}`);
  }
  return { request, requests };
}
async function withObservationRepo(body, workflow = provenance().workflow) {
  await withRepo(async ({ root, put, commit }) => {
    put("base.txt", "base");
    commit();
    put(authority.workflowPath, workflow);
    const sourceSha = commit();
    await body({ root, sourceSha });
  });
}
function resolveNonEquivalentFixture(sourceSha, found, predecessorEvidence = []) {
  return resolveFloor({
    oracle,
    sourceSha,
    collect: async (value) => (value === sourceSha ? found : empty()),
    parent: () => bootstrap.sourceSha,
    equivalent: () => ({
      equivalent: false,
      beforeInputsSha256: digest("before"),
      sourceInputsSha256: digest("source"),
    }),
    anchor: async () => ({ ...floor(bootstrap.sourceSha, ["a"]), evidence: predecessorEvidence }),
  });
}
test("API admission preserves all completed attempts while the workflow is running, including the known timeout", async () => {
  await withRepo(async ({ root, put, commit }) => {
    put(authority.workflowPath, provenance().workflow);
    const sourceSha = commit();
    const inputs = [
      hostedArtifact({ root, sourceSha, attempt: 1, kind: "raw", passes: ["a", "x"] }),
      hostedArtifact({ root, sourceSha, attempt: 2, kind: "raw", passes: ["a", "y"] }),
      hostedArtifact({
        root,
        sourceSha,
        attempt: 3,
        kind: "raw",
        passes: ["a"],
        status: "in_progress",
      }),
    ];
    const client = hostedClient(sourceSha, inputs);
    const found = await mainEvidence({ root, oracle, client }).collect(sourceSha);
    assert.equal(found.scores.length, 2);
    assert.deepEqual(
      found.evidence.map((item) => item.attempt),
      [1, 2],
    );
    const result = await resolveNonEquivalentFixture(sourceSha, found);
    assert.deepEqual(result.floorIds, ["a", "x", "y"]);
    assert.equal(
      client.requests.some((path) => path.includes("/artifacts/106/zip")),
      false,
    );
    // A cheap rerun can admit its original completed producer without a new replay.
    await admitQualificationRaw({ root, client, raw: inputs[0].payload });
    inputs[0].job.run_attempt = 2;
    await assert.rejects(
      admitQualificationRaw({ root, client, raw: inputs[0].payload }),
      /old producer attempt/,
    );
  });
});
test("API admission rejects expired evidence and never treats a cancelled producer as a floor", async () => {
  await withRepo(async ({ root, put, commit }) => {
    put(authority.workflowPath, provenance().workflow);
    const sourceSha = commit();
    const input = hostedArtifact({
      root,
      sourceSha,
      attempt: 1,
      kind: "floor",
      passes: ["a", "x"],
    });
    input.job.conclusion = "cancelled";
    const client = hostedClient(sourceSha, [input]);
    assert.deepEqual(await mainEvidence({ root, oracle, client }).collect(sourceSha), empty());
    input.artifact.expired = true;
    await assert.rejects(
      mainEvidence({ root, oracle, client }).collect(sourceSha),
      /expired-source-artifact/,
    );
  });
});
test("completed failed main attempts can admit a complete observation without sealing raw", async () => {
  await withObservationRepo(async ({ root, sourceSha }) => {
    const input = hostedObservation({ root, sourceSha });
    const client = hostedClient(sourceSha, [input]);
    const found = await mainEvidence({ root, oracle, client }).collect(sourceSha);
    assert.equal(found.scores.length, 1);
    assert.equal(found.evidence[0].kind, "observation");
    assert.equal(found.evidence[0].sealer.conclusion, "skipped");
    assert.equal(found.evidence[0].gate.conclusion, "failure");
    assert.equal(found.evidence[0].inputSha256, digest(input.input));
    assert.equal(found.evidence[0].payloadSha256, digest(input.score));
    const predecessor = { kind: "predecessor-sentinel", sourceSha: bootstrap.sourceSha };
    const result = await resolveNonEquivalentFixture(sourceSha, found, [predecessor]);
    assert.deepEqual(result.floorIds, ["a", "x"]);
    assert.deepEqual(
      result.evidence.filter((item) => item.kind === predecessor.kind),
      [predecessor],
    );
    assert.deepEqual(
      result.evidence.filter((item) => item.kind === "observation"),
      found.evidence,
    );
    assert.deepEqual(
      result.evidence.find((item) => item.kind === "scored-edge"),
      {
        kind: "scored-edge",
        beforeInputsSha256: digest("before"),
        sourceInputsSha256: digest("source"),
        sourceSha,
        beforeSha: bootstrap.sourceSha,
      },
    );
    assert.equal(
      client.requests.some((path) => path.includes("own-shell-raw")),
      false,
    );
  });
});

test("a valid raw score takes precedence over a coexisting current archive", async () => {
  await withObservationRepo(async ({ root, sourceSha }) => {
    const input = hostedObservation({ root, sourceSha });
    const raw = hostedArtifact({ root, sourceSha, attempt: 1, kind: "raw", passes: ["a", "y"] });
    input.jobs[1].conclusion = "success";
    input.jobs[3] = raw.job;
    input.artifacts.push(raw.artifact);
    input.logsByJobId[raw.job.id] = raw.logs;
    input.bytesByArtifact = { [raw.artifact.id]: raw.bytes };
    const client = hostedClient(sourceSha, [input]);
    const found = await mainEvidence({ root, oracle, client }).collect(sourceSha);
    assert.deepEqual(found.scores, [raw.payload.score]);
    assert.deepEqual(
      found.evidence.map((item) => item.kind),
      ["raw"],
    );
    assert.ok(client.requests.includes(`/actions/artifacts/${raw.artifact.id}/zip`));
    assert.ok(client.requests.includes(`/actions/jobs/${raw.job.id}/logs`));
    assert.ok(!client.requests.includes(`/actions/artifacts/${input.artifact.id}/zip`));
    assert.ok(!client.requests.includes(`/actions/jobs/${input.jobs[2].id}/logs`));
  });
});

test("collector observation boundaries reject corrupt ZIPs, missing cases and unsafe source evidence", async () => {
  const cases = [
    {
      name: "served ZIP corruption after valid upload provenance",
      patch(input) {
        const bytes = Buffer.from(input.bytes);
        bytes[0] ^= 1;
        input.bytesByArtifact = { [input.artifact.id]: bytes };
      },
      refresh: false,
      error: /archive digest mismatch/,
    },
    {
      name: "missing case with consistent stored counts",
      patch(input) {
        input.score.cases.pop();
        input.score.counts = summarize(input.score);
      },
      refresh: true,
      error: /result case count changed/,
    },
    {
      name: "unsafe diagnostics member in a non-exact archive",
      patch(input) {
        input.extraMembers = [["own-shell-diagnostics/../escape.json", "{}"]];
      },
      refresh: true,
      error: (error) => /ValueError: unsafe archive member/.test(error.stderr?.toString() ?? ""),
    },
    {
      name: "immutable workflow omits the reviewed uploader ID",
      patch() {},
      workflow: provenance().workflow.replace("      - id: current-upload\n", ""),
      refresh: true,
      error: /wrong reviewed upload step ID/,
    },
  ];
  for (const { name, patch, refresh, error, workflow } of cases) {
    await withObservationRepo(async ({ root, sourceSha }) => {
      const input = hostedObservation({ root, sourceSha });
      patch(input);
      if (refresh) input.refresh();
      const client = hostedClient(sourceSha, [input]);
      const evidence = mainEvidence({ root, oracle, client });
      await assert.rejects(evidence.collect(sourceSha), error, name);
      if (name !== "immutable workflow omits the reviewed uploader ID")
        assert.ok(client.requests.includes(`/actions/artifacts/${input.artifact.id}/zip`), name);
    }, workflow);
  }
});

test("observation admission stays closed for incomplete or wrongly gated attempts", async () => {
  const patches = [
    ["running workflow", (input) => (input.run.status = "in_progress")],
    ["successful workflow", (input) => (input.run.conclusion = "success")],
    ["failed observation", (input) => (input.jobs[2].conclusion = "failure")],
    ["cancelled observation", (input) => (input.jobs[2].conclusion = "cancelled")],
    ["running scoreboard", (input) => (input.jobs[1].status = "in_progress")],
    ["successful scoreboard", (input) => (input.jobs[1].conclusion = "success")],
    ["cancelled scoreboard", (input) => (input.jobs[1].conclusion = "cancelled")],
    ["failed sealer", (input) => (input.jobs[3].conclusion = "failure")],
    ["failed prepare", (input) => (input.jobs[0].conclusion = "failure")],
    ["running prepare", (input) => (input.jobs[0].status = "in_progress")],
  ];
  for (const [name, patch] of patches) {
    await withObservationRepo(async ({ root, sourceSha }) => {
      const input = hostedObservation({ root, sourceSha });
      patch(input);
      const found = await mainEvidence({
        root,
        oracle,
        client: hostedClient(sourceSha, [input]),
      }).collect(sourceSha);
      assert.deepEqual(found, empty(), name);
    });
  }
});

test("a skipped sealer with a raw artifact is rejected instead of borrowing it", async () => {
  await withObservationRepo(async ({ root, sourceSha }) => {
    const input = hostedObservation({ root, sourceSha });
    input.artifacts.push({
      id: 202,
      name: `own-shell-raw-${sourceSha}-${input.run.id}-${input.run.run_attempt}`,
      workflow_run: {
        id: input.run.id,
        head_sha: sourceSha,
        head_repository_id: authority.repositoryId,
      },
      expired: false,
      digest: `sha256:${"d".repeat(64)}`,
      created_at: "2026-10-24T17:00:04Z",
    });
    input.logsByJobId[14] = "";
    const evidence = mainEvidence({ root, oracle, client: hostedClient(sourceSha, [input]) });
    await assert.rejects(evidence.collect(sourceSha), /cancelled\/failed raw producer/);
  });
});

test("observation payload tampering fails closed", async () => {
  const cases = [
    ["wrong attempt", (input) => (input.input.run.attempt = 2), /observation attempt mismatch/],
    [
      "wrong inputs",
      (input) => (input.input.inputsSha256 = "0".repeat(64)),
      /observation inputs mismatch/,
    ],
    ["wrong source", (input) => (input.input.sourceSha = sha(2)), /observation source mismatch/],
    [
      "wrong selection",
      (input) => (input.input.selected.kind = "pull-request"),
      /observation source binding mismatch/,
    ],
    [
      "wrong predecessor",
      (input) => (input.input.selected.beforeSha = sha(2)),
      /merge-base|Not a valid commit name/,
    ],
    [
      "capture outside bind",
      (input) => (input.input.capturedAt = "2026-10-24T17:01:00Z"),
      /observation capture outside bind step/,
    ],
    [
      "missing score case",
      (input) => input.score.cases.pop(),
      /stored counts differ|result case count changed/,
    ],
    ["missing score member", (input) => (input.omitScore = true), /missing\/oversized JSON member/],
    [
      "score digest mismatch",
      (input) => (input.artifact.digest = `sha256:${"0".repeat(64)}`),
      /uploader digest differs/,
    ],
    ["missing upload log", (input) => (input.logOverride = ""), /job logs do not bind/],
    ["expired", (input) => (input.artifact.expired = true), /expired-source-artifact/],
    ["wrong sealer run", (input) => (input.jobs[3].run_id = 11), /wrong producer run/],
    [
      "wrong scoreboard attempt",
      (input) => (input.jobs[1].run_attempt = 2),
      /old producer attempt/,
    ],
    ["wrong prepare source", (input) => (input.jobs[0].head_sha = sha(2)), /wrong producer source/],
  ];
  for (const [name, patch, error] of cases) {
    await withObservationRepo(async ({ root, sourceSha }) => {
      const input = hostedObservation({ root, sourceSha });
      patch(input);
      if (name !== "score digest mismatch" && name !== "expired") input.refresh();
      const evidence = mainEvidence({ root, oracle, client: hostedClient(sourceSha, [input]) });
      if (name === "expired") await assert.rejects(evidence.collect(sourceSha), error);
      else await assert.rejects(evidence.collect(sourceSha), error);
    });
  }
});

test("observation uploader shape is unique and explicitly optional-file", async () => {
  await withObservationRepo(async ({ root, sourceSha }) => {
    const input = hostedObservation({ root, sourceSha });
    const uploader = {
      run: input.run,
      job: input.jobs[2],
      artifact: input.artifact,
      kind: "observation",
      workflow: input.workflow,
      logs: input.logsByJobId[13],
    };
    assert.doesNotThrow(() => assertUploader(uploader));
    assert.throws(() => assertUploader({ ...uploader, job: { ...uploader.job, name: "other" } }));
    const duplicateUploader = [
      "      - id: duplicate-upload",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: own-shell-current-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "          if-no-files-found: ignore",
      "  own-shell-compatibility:",
    ].join("\n");
    const invalidWorkflows = [
      [input.workflow.replace("      - id: current-upload\n", ""), /wrong reviewed upload step ID/],
      [
        input.workflow.replace("  own-shell-compatibility:\n", () => `${duplicateUploader}\n`),
        /unique uploader expression/,
      ],
      [
        input.workflow.replace(
          "          if-no-files-found: ignore\n",
          "          if-no-files-found: error\n",
        ),
        /observation uploader must tolerate missing files/,
      ],
    ];
    for (const [workflow, error] of invalidWorkflows)
      assert.throws(() => assertUploader({ ...uploader, workflow }), error);
    const raw = provenance();
    const rawUpload =
      "name: own-shell-raw-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}\n" +
      "          path: ${{ runner.temp }}/scoreboard-raw/raw.json\n" +
      "          retention-days: 90\n          if-no-files-found: error";
    assert.throws(
      () =>
        assertUploader({
          ...raw,
          workflow: raw.workflow.replace(rawUpload, rawUpload.replace("error", "ignore")),
        }),
      /uploader must require a file/,
    );
  });
});

function qualificationFixture(repo) {
  const { root, put } = repo;
  const project = resolve(import.meta.dirname, "..");
  const common = git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  put(".git/objects/info/alternates", `${resolve(common, "objects")}\n`);
  git(root, ["update-ref", "HEAD", bootstrap.sourceSha]);
  git(root, ["read-tree", "--empty"]);
  for (const path of ["docs/evidence/own-shell-oracle.json", "sources.lock.json"])
    put(
      path,
      execFileSync("git", ["show", `${bootstrap.sourceSha}:${path}`], {
        cwd: root,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  put(authority.workflowPath, provenance().workflow);
  git(root, ["remote", "add", "origin", root]);
  const input = rebuiltMerge(repo);
  const oracle = oracleAt(root, bootstrap.sourceSha);
  const ids = oracle.cases
    .filter((item) => !item.excluded && item.kind === "builtins-only")
    .slice(0, 2)
    .map((item) => item.id)
    .sort();
  const score = (passes) => {
    const cases = oracle.cases.map(({ bash: _bash, ...item }) => ({
      ...item,
      outcome:
        item.excluded || item.kind !== "builtins-only"
          ? "skip"
          : passes.includes(item.id)
            ? "pass"
            : "fail",
    }));
    return { engine: "own-shell", identity: oracle.identity, cases, counts: summarize({ cases }) };
  };
  const requiredFloor = { ...floor(input.mainSha, ids), identity: oracle.identity };
  const main = hostedArtifact({
    root,
    sourceSha: input.mainSha,
    attempt: 1,
    kind: "floor",
    observation: score(ids),
    requiredFloor,
  });
  const mainClient = hostedClient(input.mainSha, [main]);
  const run = {
    ...input.run,
    id: 11,
    run_attempt: 1,
    head_repository: { id: authority.repositoryId },
  };
  let rawClient;
  const client = {
    requests: [],
    observedMain: input.mainSha,
    async request(path) {
      this.requests.push(path);
      if (path === "/git/ref/heads/main") return { object: { sha: this.observedMain } };
      if (path === "/actions/runs/11/attempts/1") return run;
      if (
        path.startsWith("/actions/runs/11/") ||
        path === "/actions/jobs/99/logs" ||
        path === "/actions/artifacts/999/zip"
      )
        return rawClient.request(path);
      assert.ok(
        !path.includes(input.event.pull_request.base.sha),
        "stale event base must not replace current main floor",
      );
      return mainClient.request(path);
    },
  };
  function publish(raw) {
    const value = hostedArtifact({
      root,
      sourceSha: input.sourceSha,
      attempt: 1,
      kind: "raw",
      observation: raw.score,
      requiredFloor,
    });
    value.run = run;
    Object.assign(value.job, { id: 99, run_id: 11, head_sha: run.head_sha });
    value.bytes = archive([["raw.json", JSON.stringify(raw)]]);
    Object.assign(value.artifact, {
      id: 999,
      name: `own-shell-raw-${input.sourceSha}-11-1`,
      digest: `sha256:${bytesDigest(value.bytes)}`,
      workflow_run: { id: 11, head_sha: run.head_sha, head_repository_id: authority.repositoryId },
    });
    value.logs = `2026-10-24T17:00:01.100Z SHA256 digest of uploaded artifact zip is ${bytesDigest(value.bytes)}\n2026-10-24T17:00:01.200Z Artifact ${value.artifact.name} has been successfully uploaded! Final size is ${value.bytes.length} bytes. Artifact ID is 999\n`;
    rawClient = hostedClient(input.sourceSha, [value]);
  }
  return { ...input, client, ids, score, publish };
}
async function withQualificationEnvironment(input, body) {
  const eventPath = resolve(input.root, "event.json");
  writeFileSync(eventPath, JSON.stringify(input.event));
  const values = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SHA: input.sourceSha,
    GITHUB_RUN_ID: "11",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    restoreEnvironment(previous);
  }
}
function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
async function assertQualificationLifecycle(input) {
  const { root, client, ids } = input;
  const preparedPath = resolve(root, "prepared.json");
  await prepareQualification({ root, client, output: preparedPath });
  const prepared = JSON.parse(readFileSync(preparedPath, "utf8"));
  assert.equal(prepared.selected.baseSha, input.mainSha);
  assert.equal(prepared.selected.mainSha, input.mainSha);
  assert.equal(prepared.floor.sourceSha, input.mainSha);
  assert.deepEqual(prepared.floor.floorIds, ids);
  client.observedMain = git(root, [
    "commit-tree",
    `${input.mainSha}^{tree}`,
    "-p",
    input.mainSha,
    "-m",
    "advanced main",
  ]);
  const scorePath = resolve(root, "score.json");
  const rawDirectory = resolve(root, "raw");
  const output = resolve(root, "folded");
  writeFileSync(scorePath, JSON.stringify(input.score(ids)));
  const seal = () => sealRaw({ root, input: preparedPath, scorePath, output: rawDirectory });
  const invalid = structuredClone(prepared);
  invalid.selected.baseSha = input.event.pull_request.base.sha;
  writeFileSync(preparedPath, JSON.stringify(invalid));
  assert.throws(seal, /prepared source binding mismatch/);
  writeFileSync(preparedPath, JSON.stringify(prepared));
  const rawPath = resolve(rawDirectory, "raw.json");
  for (const passes of [ids, ids.slice(0, 1)]) {
    writeFileSync(scorePath, JSON.stringify(input.score(passes)));
    seal();
    const raw = JSON.parse(readFileSync(rawPath, "utf8"));
    assert.deepEqual(raw.selected, prepared.selected);
    input.publish(raw);
    const folded = await foldQualification({ root, client, rawPath, output });
    assert.deepEqual(folded.binding, prepared.selected);
    assert.equal(folded.observedMainAfter, client.observedMain);
    assert.equal(folded.floorSha256, prepared.floor.floorSha256);
    assert.equal(folded.ok, passes.length === ids.length);
    assert.deepEqual(
      Object.values(folded.corpora).flatMap((row) => row.lost),
      ids.filter((id) => !passes.includes(id)),
    );
  }
  assert.ok(client.requests.includes("/actions/artifacts/999/zip"));
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  raw.selected.baseSha = input.event.pull_request.base.sha;
  writeFileSync(rawPath, JSON.stringify(raw));
  await assert.rejects(
    foldQualification({ root, client, rawPath, output }),
    /qualification binding mismatch/,
  );
}
test("stale-event preparation, sealing and host-admitted folding preserve the captured current-main floor", async () => {
  await withRepo(async (repo) => {
    const input = qualificationFixture(repo);
    await withQualificationEnvironment(input, () => assertQualificationLifecycle(input));
  });
});

test("workflow baseline commands select the tested main parent for both gates and the predecessor for pushes", async () => {
  await withRepo(async (repo) => {
    const input = rebuiltMerge(repo);
    await withQualificationEnvironment(input, () => assertBaselineCommands(repo, input));
  });
});
function assertBaselineCommands({ root, put }, input) {
  for (const file of [
    "scoreboard-ci.ts",
    "shell-scoreboard-main.ts",
    "shell-scoreboard-floor.ts",
    "shell-scoreboard.ts",
    "shell-scoreboard-accepted-gains.ts",
    "shell-scoreboard-terminal-recovery.ts",
  ])
    put(`scripts/${file}`, readFileSync(new URL(file, import.meta.url)));
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), resolve(root, "node_modules"));
  git(root, ["update-ref", "refs/remotes/origin/main", input.mainSha]);
  const output = resolve(root, "github-env");
  const env = { ...process.env, GITHUB_ENV: output };
  const execute = (name) =>
    execFileSync(process.execPath, [resolve(root, "scripts/scoreboard-ci.ts"), "baseline", name], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  for (const name of ["LAYERS_BASE_REF", "BASH_COMPAT_BASE_REF"]) {
    writeFileSync(output, "");
    execute(name);
    assert.equal(readFileSync(output, "utf8"), `${name}=${input.mainSha}\n`);
  }
  assert.throws(() => execute("NODE_OPTIONS"));
  const dependent = structuredClone(input.event);
  dependent.pull_request.base.ref = "terminal/a2-multiline";
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(dependent));
  writeFileSync(output, "");
  execute("LAYERS_BASE_REF");
  assert.equal(readFileSync(output, "utf8"), `LAYERS_BASE_REF=${input.mainSha}\n`);
  assert.throws(() => execute("BASH_COMPAT_BASE_REF"), /PR does not target main/);
  const foreign = structuredClone(dependent);
  foreign.pull_request.base.repo.id++;
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(foreign));
  assert.throws(() => execute("LAYERS_BASE_REF"), /PR base repository/);
  const forged = structuredClone(dependent);
  forged.pull_request.head.sha = input.mainSha;
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(forged));
  assert.throws(() => execute("LAYERS_BASE_REF"), /second parent differs/);
  const unrelated = structuredClone(dependent);
  unrelated.pull_request.base.sha = input.event.pull_request.head.sha;
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(unrelated));
  assert.throws(() => execute("LAYERS_BASE_REF"), /event base is not in tested base history/);

  const push = {
    repository: input.event.repository,
    ref: "refs/heads/main",
    after: input.sourceSha,
    before: input.mainSha,
  };
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(push));
  env.GITHUB_EVENT_NAME = "push";
  writeFileSync(output, "");
  execute("LAYERS_BASE_REF");
  assert.equal(readFileSync(output, "utf8"), `LAYERS_BASE_REF=${input.mainSha}\n`);
  push.before = "0".repeat(40);
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(push));
  assert.throws(() => execute("LAYERS_BASE_REF"));
}
