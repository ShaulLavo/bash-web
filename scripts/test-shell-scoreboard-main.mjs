import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  resolveFloor,
  scoringInputs,
  sourceEquivalent,
} from "./shell-scoreboard-main.mjs";
import { bootstrap } from "./shell-scoreboard-floor.mjs";
import { bytesDigest, digest } from "./shell-scoreboard.mjs";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.mjs";
import { verifyBinding } from "./scoreboard-ci.mjs";

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
    { input: JSON.stringify(entries), stdio: ["pipe", "pipe", "ignore"] },
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
    const event = {
      repository: { id: authority.repositoryId },
      pull_request: {
        head: { sha: headSha },
        base: { sha: baseSha, ref: "main", repo: { id: authority.repositoryId } },
      },
    };
    const run = {
      repository: { id: authority.repositoryId },
      workflow_id: authority.workflowId,
      path: authority.workflowPath,
      event: "pull_request",
      head_sha: headSha,
    };
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

function hostedArtifact({ root, sourceSha, attempt, kind, passes, status = "completed" }) {
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
    resultSha256: digest(score(passes)),
    score: score(passes),
  };
  const payload =
    kind === "raw"
      ? raw
      : {
          ...floor(sourceSha, passes),
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
function hostedClient(sourceSha, inputs) {
  const requests = [];
  async function request(path) {
    requests.push(path);
    if (path.startsWith(`/actions/workflows/${authority.workflowId}/runs?`))
      return {
        total_count: 1,
        workflow_runs: [
          { id: 10, run_attempt: Math.max(...inputs.map((item) => item.run.run_attempt)) },
        ],
      };
    if (path === "/actions/runs/10/artifacts?per_page=100")
      return { total_count: inputs.length, artifacts: inputs.map((item) => item.artifact) };
    const attempt = path.match(/^\/actions\/runs\/10\/attempts\/(\d+)(\/jobs\?per_page=100)?$/);
    if (attempt) {
      const selected = inputs.filter((item) => item.run.run_attempt === Number(attempt[1]));
      if (attempt[2])
        return { total_count: selected.length, jobs: selected.map((item) => item.job) };
      return selected[0]?.run;
    }
    const logs = inputs.find((item) => path === `/actions/jobs/${item.job.id}/logs`);
    if (logs) return logs.logs;
    const artifact = inputs.find((item) => path === `/actions/artifacts/${item.artifact.id}/zip`);
    if (artifact) return artifact.bytes;
    throw new Error(`unexpected host request ${path} at ${sourceSha}`);
  }
  return { request, requests };
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
    const result = await resolveFloor({
      oracle,
      sourceSha,
      collect: async (value) => (value === sourceSha ? found : empty()),
      parent: () => bootstrap.sourceSha,
      equivalent: () => ({
        equivalent: false,
        beforeInputsSha256: digest("before"),
        sourceInputsSha256: digest("source"),
      }),
      anchor: async () => floor(bootstrap.sourceSha, ["a"]),
    });
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
