import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  assertControllerTrust,
  assertMainDispatchRun,
  collectMainDispatches,
  controllerInputs,
  foldMainDispatch,
  mainDispatchTitle,
  prepareMainDispatch,
  sealMainDispatch,
} from "./shell-scoreboard-main-dispatch.ts";
import {
  authority,
  git,
  mainEvidence,
  oracleAt,
  resolveMainFloor,
  scoringInputs,
} from "./shell-scoreboard-main.ts";
import type {
  EvidenceSet,
  GithubClient,
  HostArtifact,
  HostJob,
  HostRun,
} from "./shell-scoreboard-main.ts";
import { assertMainFloor, bootstrap, qualification } from "./shell-scoreboard-floor.ts";
import { foldQualification, verifyBinding } from "./scoreboard-ci.ts";
import type { MainFloor } from "./shell-scoreboard-floor.ts";
import { bytesDigest, digest } from "./shell-scoreboard.ts";
import type { MainDispatchBinding, Score } from "./shell-scoreboard.ts";
import { frozenScore } from "./shell-scoreboard-test-score.ts";

const project = resolve(import.meta.dirname, "..");
const discovery = `/actions/workflows/${authority.workflowId}/runs?event=workflow_dispatch&per_page=100&page=1`;
const names = [
  "Bind exact main source",
  "Observe unchanged main source",
  "Seal exact main raw score",
  "Upload exact main raw score",
  "Fold exact main floor",
  "Upload exact main floor",
];
function zip(member: string, value: unknown): Buffer {
  return execFileSync(
    "python3",
    [
      "-c",
      "import sys,io,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); z.writestr(sys.argv[1],sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())",
      member,
    ],
    { input: JSON.stringify(value) },
  );
}
function put(root: string, path: string, value: string | Buffer): void {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), value);
}
function commit(root: string, message: string): string {
  git(root, ["add", "--all"]);
  git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
interface Hosted {
  run: HostRun;
  jobs: HostJob[];
  artifacts: HostArtifact[];
  bytes: Map<number, Buffer>;
  logs: Map<number, string>;
}
function hostRun(sourceSha: string, id: number, event = "push", attempt = 1): HostRun {
  return {
    id,
    run_attempt: attempt,
    head_sha: sourceSha,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    head_branch: "main",
    event,
    status: "completed",
    conclusion: "success",
  };
}
function step(name: string, index: number) {
  return {
    name,
    number: index + 1,
    status: "completed",
    conclusion: "success",
    started_at: new Date(Date.UTC(2026, 10, 13, 12, index)).toISOString(),
    completed_at: new Date(Date.UTC(2026, 10, 13, 12, index, 10)).toISOString(),
  };
}
function job(run: HostRun, name: string, id: number, steps: string[]): HostJob {
  return {
    id,
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
    steps: steps.map(step),
  };
}
function publish(
  host: Hosted,
  producer: HostJob,
  member: string,
  value: unknown,
  name: string,
  uploadIndex: number,
): void {
  const id = host.run.id * 1000 + host.run.run_attempt * 10 + host.artifacts.length;
  const bytes = zip(member, value);
  const digest = bytesDigest(bytes);
  const created = producer.steps[uploadIndex].started_at ?? "";
  host.artifacts.push({
    id,
    name,
    digest: `sha256:${digest}`,
    expired: false,
    created_at: created,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: {
      id: host.run.id,
      head_sha: host.run.head_sha,
      head_repository_id: authority.repositoryId,
    },
  });
  host.bytes.set(id, bytes);
  const logs = `${created} SHA256 digest of uploaded artifact zip is ${digest}\n${created} Artifact ${name} has been successfully uploaded! Final size is ${bytes.length} bytes. Artifact ID is ${id}\n`;
  host.logs.set(producer.id, (host.logs.get(producer.id) ?? "") + logs);
}
function emptyHost(run: HostRun): Hosted {
  return { run, jobs: [], artifacts: [], bytes: new Map(), logs: new Map() };
}
async function fixture(
  body: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>,
): Promise<void> {
  const scratch = mkdtempSync(resolve(process.env.TMPDIR ?? tmpdir(), "main-dispatch-"));
  try {
    await body(await setup(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
async function setup(scratch: string) {
  const root = resolve(scratch, "executor");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "fixture"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  const common = git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  put(root, ".git/objects/info/alternates", `${common}/objects\n`);
  git(root, ["update-ref", "HEAD", bootstrap.sourceSha]);
  git(root, ["read-tree", "--empty"]);
  for (const path of ["docs/evidence/own-shell-oracle.json", "sources.lock.json"])
    put(
      root,
      path,
      execFileSync("git", ["show", `${bootstrap.sourceSha}:${path}`], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  const paths = [
    authority.workflowPath,
    ".github/actions/wasi-sdk/action.yml",
    "package.json",
    "package-lock.json",
    "scripts/shell-scoreboard.ts",
    "scripts/shell-scoreboard-floor.ts",
    "scripts/shell-scoreboard-main.ts",
    "scripts/shell-scoreboard-main-dispatch.ts",
  ];
  for (const path of paths) put(root, path, readFileSync(resolve(project, path)));
  const beforeSha = commit(root, "base");
  put(
    root,
    "scripts/shell-scoreboard-main-dispatch.ts",
    "historical source, never replaced in measured checkout\n",
  );
  const sourceSha = commit(root, "historical main");
  put(
    root,
    "scripts/shell-scoreboard-main-dispatch.ts",
    readFileSync(resolve(project, "scripts/shell-scoreboard-main-dispatch.ts")),
  );
  const executorSha = commit(root, "controller repair");
  git(root, ["remote", "add", "origin", root]);
  const measuredRoot = resolve(scratch, "measured");
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", root, measuredRoot]);
  git(measuredRoot, ["checkout", "-q", "--detach", sourceSha]);
  const oracle = oracleAt(root, bootstrap.sourceSha);
  const ids = oracle.cases
    .filter((item) => item.kind === "builtins-only" && !item.excluded)
    .slice(0, 3)
    .map((item) => item.id)
    .sort();
  const score = (passes: string[]): Score => frozenScore(oracle, passes);
  const hosts: Hosted[] = [];
  const requests: string[] = [];
  const state: {
    main: string;
    discoveryCount: number;
    discoveryPages: { total_count: number; workflow_runs: HostRun[] }[] | undefined;
    pushCount: number | undefined;
    incompleteEvidence: "jobs" | "artifacts" | undefined;
  } = {
    main: sourceSha,
    discoveryCount: 1,
    discoveryPages: undefined,
    pushCount: undefined,
    incompleteEvidence: undefined,
  };
  function request(path: string, type: "bytes"): Promise<Buffer>;
  function request(path: string, type: "text"): Promise<string>;
  function request(path: string, type?: "json"): Promise<unknown>;
  async function request(path: string, type = "json"): Promise<unknown> {
    requests.push(path);
    if (path === "/git/ref/heads/main") return { object: { sha: state.main } };
    if (path.includes("?event=workflow_dispatch&") && state.discoveryPages) {
      const page = Number(new URL(path, "https://fixture.invalid").searchParams.get("page"));
      const listing = state.discoveryPages[page - 1];
      assert.ok(listing, `unexpected discovery page ${page}`);
      return listing;
    }
    if (path === discovery)
      return {
        total_count: state.discoveryCount,
        workflow_runs: hosts
          .filter((item) => item.run.event !== "push")
          .filter(
            (item, index, items) =>
              !items.slice(index + 1).some((next) => next.run.id === item.run.id),
          )
          .map((item) => item.run),
      };
    if (path.includes("?event=push&")) {
      const selected = hosts.filter(
        (item) => item.run.event === "push" && path.includes(`head_sha=${item.run.head_sha}&`),
      );
      return {
        total_count: state.pushCount ?? selected.length,
        workflow_runs: selected.map((item) => item.run),
      };
    }
    if (state.incompleteEvidence === "jobs" && path.endsWith("/jobs?per_page=100"))
      return { total_count: 2, jobs: [] };
    if (state.incompleteEvidence === "artifacts" && path.endsWith("/artifacts?per_page=100"))
      return { total_count: 1, artifacts: [] };
    return hostResponse(hosts, path, type);
  }
  const client: GithubClient = { request };
  const base: MainFloor = {
    schema: 1,
    kind: "main-floor",
    sourceSha: beforeSha,
    identity: oracle.identity,
    floorIds: ids.slice(0, 1),
    floorSha256: digest(ids.slice(0, 1)),
    evidence: [],
  };
  function pushFloor(source: string, floor: MainFloor): Hosted {
    const host = emptyHost(hostRun(source, 10 + hosts.length));
    const producer = job(host.run, "score-floor", host.run.id * 10, [
      "Fold main floor and qualification",
      "Upload cumulative main floor",
    ]);
    host.jobs.push(producer);
    publish(
      host,
      producer,
      "floor.json",
      { ...floor, run: { runId: host.run.id, attempt: 1 } },
      `own-shell-floor-${source}-${host.run.id}-1`,
      1,
    );
    hosts.push(host);
    return host;
  }
  pushFloor(beforeSha, base);
  const run = hostRun(executorSha, 20, "workflow_dispatch");
  Object.assign(run, {
    head_branch: "repair",
    display_title: mainDispatchTitle(sourceSha),
    status: "in_progress",
    conclusion: null,
  });
  const host = emptyHost(run);
  host.jobs.push(
    job(run, "main-qualification", 200, names),
    job(run, "shell", 201, ["Require every check"]),
  );
  hosts.push(host);
  const prepared = await prepareMainDispatch({
    root,
    measuredRoot,
    client,
    sourceSha,
    executorRef: "refs/heads/repair",
    run: { runId: 20, attempt: 1 },
  });
  prepared.capturedAt = "2026-11-13T12:00:05Z";
  const raw = sealMainDispatch({ root, measuredRoot, prepared, score: score(ids.slice(0, 2)) });
  const folded = await foldMainDispatch({ root, client, raw });
  function publishMain(target: Hosted, input: typeof raw, floor: MainFloor): void {
    const producer = target.jobs[0];
    publish(
      target,
      producer,
      "raw.json",
      input,
      `own-shell-main-raw-${sourceSha}-${target.run.id}-${target.run.run_attempt}`,
      3,
    );
    publish(
      target,
      producer,
      "floor.json",
      floor,
      `own-shell-main-floor-${sourceSha}-${target.run.id}-${target.run.run_attempt}`,
      5,
    );
    Object.assign(target.run, { status: "completed", conclusion: "success" });
  }
  publishMain(host, raw, folded.floor);
  return {
    root,
    measuredRoot,
    client,
    oracle,
    ids,
    score,
    hosts,
    host,
    raw,
    prepared,
    folded,
    state,
    requests,
    beforeSha,
    sourceSha,
    executorSha,
    pushFloor,
    publishMain,
  };
}
function hostResponse(hosts: Hosted[], path: string, type: string): unknown {
  for (const host of hosts) {
    const prefix = `/actions/runs/${host.run.id}/attempts/${host.run.run_attempt}`;
    if (path === prefix) return host.run;
    if (path === `${prefix}/jobs?per_page=100`)
      return { total_count: host.jobs.length, jobs: host.jobs };
    if (path === `/actions/runs/${host.run.id}/artifacts?per_page=100`) {
      const artifacts = hosts
        .filter((item) => item.run.id === host.run.id)
        .flatMap((item) => item.artifacts);
      return { total_count: artifacts.length, artifacts };
    }
    const log = path.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (type === "text" && log && host.logs.has(Number(log[1])))
      return host.logs.get(Number(log[1]));
    const artifact = path.match(/^\/actions\/artifacts\/(\d+)\/zip$/);
    if (type === "bytes" && artifact && host.bytes.has(Number(artifact[1])))
      return host.bytes.get(Number(artifact[1]));
  }
  throw new Error(`unexpected host request ${path}`);
}
function empty(): EvidenceSet {
  return { floors: [], scores: [], evidence: [] };
}
async function collect(value: Awaited<ReturnType<typeof setup>>) {
  const result = empty();
  await collectMainDispatches({ ...value, result });
  return result;
}

test("exact historical main is measured without changing its source or borrowing its controller identity", async () => {
  await fixture(async (value) => {
    const found = await collect(value);
    assert.equal(found.scores.length, 1);
    assert.equal(found.floors[0].sourceSha, value.sourceSha);
    assert.notEqual(value.executorSha, value.sourceSha);
    assert.equal(
      readFileSync(
        resolve(value.measuredRoot, "scripts/shell-scoreboard-main-dispatch.ts"),
        "utf8",
      ),
      "historical source, never replaced in measured checkout\n",
    );
    const resolved = await resolveMainFloor({
      root: value.root,
      client: value.client,
      sourceSha: value.sourceSha,
    });
    assert.deepEqual(resolved.floor.floorIds, value.ids.slice(0, 2));
  });
});

test("preparation captures current main once; admission accepts its later first-parent ancestry", async () => {
  await fixture(async (value) => {
    value.state.main = value.executorSha;
    assert.equal((await collect(value)).scores.length, 1);
    await assert.rejects(
      prepareMainDispatch({
        ...value,
        executorRef: "refs/heads/repair",
        run: { runId: 20, attempt: 1 },
      }),
      /exact current main/,
    );
    value.state.main = value.beforeSha;
    await assert.rejects(collect(value), /not in main history/);
  });
});

test("main dispatch rejects repository, workflow, event, executor, ref, predecessor and attempt mismatches", async () => {
  await fixture(async (value) => {
    for (const patch of [
      { repository: { id: 1 } },
      { head_repository: { id: 1 } },
      { workflow_id: 1 },
      { path: "other.yml" },
      { event: "pull_request" },
      { event: "schedule" },
      { head_sha: value.sourceSha },
      { head_branch: "other" },
      { run_attempt: 2 },
      { display_title: "branch qualification" },
    ])
      assert.throws(() =>
        assertMainDispatchRun(value.root, { ...value.host.run, ...patch }, value.raw.selected, 1),
      );
    assert.throws(
      () =>
        assertMainDispatchRun(
          value.root,
          value.host.run,
          { ...value.raw.selected, beforeSha: value.executorSha },
          1,
        ),
      /predecessor/,
    );
    assert.throws(
      () =>
        assertMainDispatchRun(
          value.root,
          value.host.run,
          { ...value.raw.selected, executorRef: "refs/tags/main" },
          1,
        ),
      /ref/,
    );
    assert.throws(
      () =>
        assertControllerTrust(value.root, {
          ...value.raw.selected,
          controllerSha256: "0".repeat(64),
        }),
      /digest mismatch/,
    );
    put(value.root, "package.json", "{}\n");
    commit(value.root, "changed controller dependencies");
    assert.throws(
      () => assertControllerTrust(value.root, value.raw.selected),
      /trusted consumer controller/,
    );
  });
});

test("unfinished, failed, cancelled and aggregate-failed dispatches admit neither scores nor floors", async () => {
  await fixture(async (value) => {
    for (const patch of [
      { status: "in_progress", conclusion: null },
      { conclusion: "failure" },
      { conclusion: "cancelled" },
    ]) {
      Object.assign(value.host.run, { status: "completed", conclusion: "success" }, patch);
      assert.deepEqual(await collect(value), empty());
    }
    Object.assign(value.host.run, { status: "completed", conclusion: "success" });
    value.host.jobs[1].conclusion = "failure";
    await assert.rejects(collect(value), /failed main dispatch aggregate/);
    value.host.jobs[1].conclusion = "success";
    value.host.jobs[0].conclusion = "skipped";
    assert.deepEqual(await collect(value), empty());
  });
});

test("ordinary branch dispatches and PR runs never become main evidence", async () => {
  await fixture(async (value) => {
    value.host.run.display_title = "Ordinary branch dispatch";
    assert.deepEqual(await collect(value), empty());
    value.host.run.display_title = mainDispatchTitle(value.sourceSha);
    value.host.run.event = "pull_request";
    await assert.rejects(collect(value), /wrong main dispatch event/);
  });
});

test("artifact and uploader provenance stays strict for genuine main dispatches", async () => {
  await fixture(async (value) => {
    const artifact = value.host.artifacts[0];
    const original = structuredClone(artifact);
    for (const patch of [
      { expired: true },
      { digest: `sha256:${"0".repeat(64)}` },
      { id: 1 },
      { created_at: "2000-01-01T00:00:00Z" },
      {
        workflow_run: {
          id: 1,
          head_sha: value.executorSha,
          head_repository_id: authority.repositoryId,
        },
      },
    ]) {
      Object.assign(artifact, original, patch);
      await assert.rejects(collect(value));
    }
    Object.assign(artifact, original);
    const producer = value.host.jobs[0];
    for (const patch of [
      { run_id: 1 },
      { run_attempt: 2 },
      { head_sha: value.sourceSha },
      { status: "in_progress" },
      { conclusion: "failure" },
    ]) {
      const previous = structuredClone(producer);
      Object.assign(producer, patch);
      await assert.rejects(collect(value));
      Object.assign(producer, previous);
    }
    producer.steps[1].started_at = "2026-11-13T11:00:00Z";
    await assert.rejects(collect(value), /out-of-order/);
  });
});

test("serialized source, score, predecessor and floor substitutions cannot borrow genuine uploads", async () => {
  await fixture(async (value) => {
    const republish = (raw: unknown, floor: MainFloor = value.folded.floor) => {
      value.host.artifacts.length = 0;
      value.host.bytes.clear();
      value.host.logs.clear();
      publish(
        value.host,
        value.host.jobs[0],
        "raw.json",
        raw,
        `own-shell-main-raw-${value.sourceSha}-20-1`,
        3,
      );
      publish(
        value.host,
        value.host.jobs[0],
        "floor.json",
        floor,
        `own-shell-main-floor-${value.sourceSha}-20-1`,
        5,
      );
    };
    for (const patch of [
      { kind: "raw-score" },
      { observedMainSha: value.beforeSha },
      { run: { runId: 20, attempt: 2 } },
      { inputsSha256: "0".repeat(64) },
      { resultSha256: "0".repeat(64) },
      { selected: { ...value.raw.selected, sourceSha: value.executorSha } },
      { selected: { ...value.raw.selected, executorRef: "refs/heads/main" } },
      { selected: { ...value.raw.selected, beforeSha: value.executorSha } },
      { capturedAt: "2026-11-13T11:00:00Z" },
    ]) {
      republish({ ...value.raw, ...patch });
      await assert.rejects(collect(value));
    }
    const score = { ...value.raw.score, cases: value.raw.score.cases.slice(1) };
    republish({ ...value.raw, score, resultSha256: digest(score) });
    await assert.rejects(collect(value));
    republish(value.raw, { ...value.folded.floor, beforeSha: value.executorSha });
    await assert.rejects(collect(value), /strictly equal/);
    republish(value.raw);
    value.host.artifacts.push(value.host.artifacts[0]);
    await assert.rejects(collect(value), /ambiguous/);
  });
});

test("sealing rejects modified measured sources and folding rejects lost predecessor passes before publishing", async () => {
  await fixture(async (value) => {
    put(value.measuredRoot, "scripts/shell-scoreboard-main-dispatch.ts", "changed\n");
    assert.throws(
      () => sealMainDispatch({ ...value, prepared: value.prepared, score: value.raw.score }),
      /modified measured source/,
    );
    git(value.measuredRoot, ["restore", "--", "scripts/shell-scoreboard-main-dispatch.ts"]);
    const score = value.score([]);
    await assert.rejects(
      foldMainDispatch({ ...value, raw: { ...value.raw, score, resultSha256: digest(score) } }),
      /required main passes were lost/,
    );
  });
});

test("every successful earlier attempt stays required when a later attempt fails", async () => {
  await fixture(async (value) => {
    const second = emptyHost({
      ...value.host.run,
      run_attempt: 2,
      status: "in_progress",
      conclusion: null,
    });
    second.jobs.push(
      job(second.run, "main-qualification", 202, names),
      job(second.run, "shell", 203, ["Require every check"]),
    );
    value.hosts.push(second);
    const score2 = value.score(value.ids);
    const raw2 = {
      ...value.raw,
      run: { runId: 20, attempt: 2 },
      score: score2,
      resultSha256: digest(score2),
    };
    assert.equal((await collect(value)).scores.length, 1);
    const folded2 = await foldMainDispatch({ ...value, raw: raw2 });
    value.publishMain(second, raw2, folded2.floor);
    value.hosts.push(emptyHost({ ...value.host.run, run_attempt: 3, conclusion: "failure" }));
    assert.equal((await collect(value)).scores.length, 2);
    const resolved = await resolveMainFloor({ ...value, sourceSha: value.sourceSha });
    assert.deepEqual(resolved.floor.floorIds, value.ids);
    const score = value.score(value.ids.slice(0, 2));
    await assert.rejects(
      foldMainDispatch({
        ...value,
        raw: { ...value.raw, run: { runId: 20, attempt: 3 }, score, resultSha256: digest(score) },
      }),
      /required main passes were lost/,
    );
  });
});

test("discovery exhaustion and unavailable evidence are explicit prerequisites", async () => {
  await fixture(async (value) => {
    value.state.discoveryCount = 3201;
    await assert.rejects(collect(value), /prerequisite: main dispatch discovery exhausted/);
    value.state.discoveryCount = 1;
    value.host.run.run_attempt = 33;
    await assert.rejects(collect(value), /too many main dispatch attempts/);
    value.host.run.run_attempt = 1;
    value.host.bytes.clear();
    await assert.rejects(collect(value), /unexpected host request/);
  });
});

test("dispatch discovery rejects a count change that omits a surviving page-boundary run", async () => {
  await fixture(async (value) => {
    const runs = Array.from({ length: 201 }, (_, index) =>
      hostRun(value.executorSha, 1000 + index, "workflow_dispatch"),
    );
    value.state.discoveryPages = [
      { total_count: 201, workflow_runs: runs.slice(0, 100) },
      { total_count: 200, workflow_runs: runs.slice(101) },
    ];
    await assert.rejects(collect(value), /prerequisite: unstable main dispatch discovery/);
    value.state.discoveryPages = [
      { total_count: 201, workflow_runs: runs.slice(0, 100) },
      { total_count: 201, workflow_runs: runs.slice(100, 200) },
      { total_count: 201, workflow_runs: runs.slice(200) },
    ];
    assert.equal((await collect(value)).scores.length, 0);
  });
});

test("main push discovery rejects a missing row despite a nonzero reported count", async () => {
  await fixture(async (value) => {
    value.state.pushCount = 1;
    await assert.rejects(
      mainEvidence(value).collect(value.sourceSha),
      /prerequisite: incomplete main push discovery/,
    );
  });
});

test("dispatch admission rejects incomplete job and artifact evidence", async () => {
  const listings: ("jobs" | "artifacts")[] = ["jobs", "artifacts"];
  for (const listing of listings) {
    await fixture(async (value) => {
      value.state.incompleteEvidence = listing;
      await assert.rejects(collect(value), /scoreboard prerequisite: incomplete/);
    });
  }
});

test("the first ordinary main push carries requirements beyond later Waffle manifest changes", async () => {
  await fixture(async (value) => {
    const inherited = (await mainEvidence(value).collect(value.sourceSha)).floors[0];
    const landed = await firstMainPush(value);
    assert.ok(inherited.floorIds.every((id) => landed.floorIds.includes(id)));
    value.state.main = value.executorSha;
    put(
      value.root,
      "package.json",
      JSON.stringify({
        devDependencies: {
          waffle:
            "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.129/waffle-0.0.129.tgz",
        },
      }),
    );
    put(value.root, "package-lock.json", "{}\n");
    const headSha = commit(value.root, "adopt Waffle .129");
    assert.throws(
      () => assertControllerTrust(value.root, value.raw.selected),
      /trusted consumer controller/,
    );
    const resolved = await resolveMainFloor({ ...value, sourceSha: value.executorSha });
    assert.deepEqual(resolved.floor.floorIds, value.ids);
    const testedMergeSha = git(value.root, [
      "commit-tree",
      git(value.root, ["rev-parse", `${headSha}^{tree}`]),
      "-p",
      value.executorSha,
      "-p",
      headSha,
      "-m",
      "tested PR merge",
    ]);
    git(value.root, ["checkout", "-q", "--detach", testedMergeSha]);
    const binding = verifyBinding({
      root: value.root,
      sourceSha: testedMergeSha,
      mainSha: value.executorSha,
      eventName: "pull_request",
      run: hostRun(headSha, 40, "pull_request"),
      event: {
        repository: { id: authority.repositoryId },
        pull_request: {
          head: { sha: headSha },
          base: { sha: value.executorSha, ref: "main", repo: { id: authority.repositoryId } },
        },
      },
    });
    assert.equal(
      qualification(value.oracle, resolved.floor, value.score(value.ids), binding).ok,
      true,
    );
  });
});

async function firstMainPush(value: Awaited<ReturnType<typeof setup>>): Promise<MainFloor> {
  value.state.main = value.executorSha;
  const host = emptyHost(hostRun(value.executorSha, 30));
  const producer = job(host.run, "own-shell-compatibility", 300, [
    "Seal complete raw score",
    "Upload complete raw score",
  ]);
  host.jobs.push(producer);
  value.hosts.push(host);
  const score = value.score(value.ids);
  const raw = {
    schema: 1,
    kind: "raw-score",
    capturedAt: "2026-11-13T12:00:05Z",
    sourceSha: value.executorSha,
    selected: { kind: "main-push", sourceSha: value.executorSha, beforeSha: value.sourceSha },
    run: { runId: 30, attempt: 1 },
    inputsSha256: digest(scoringInputs(value.root, value.executorSha)),
    resultSha256: digest(score),
    score,
    floor: null,
  };
  publish(host, producer, "raw.json", raw, `own-shell-raw-${value.executorSha}-30-1`, 1);
  const directory = resolve(value.root, "../push");
  mkdirSync(directory);
  const rawPath = resolve(directory, "raw.json");
  writeFileSync(rawPath, JSON.stringify(raw));
  const eventPath = resolve(directory, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      repository: { id: authority.repositoryId },
      ref: "refs/heads/main",
      after: value.executorSha,
      before: value.sourceSha,
    }),
  );
  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "push",
    GITHUB_RUN_ID: "30",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: value.executorSha,
  };
  const original = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, env);
    const result = await foldQualification({ ...value, rawPath, output: directory });
    assert.equal(result.ok, true);
  } finally {
    restoreEnvironment(original);
  }
  const floor: unknown = JSON.parse(readFileSync(resolve(directory, "floor.json"), "utf8"));
  assertMainFloor(floor);
  const gate = job(host.run, "score-floor", 301, [
    "Fold main floor and qualification",
    "Upload cumulative main floor",
  ]);
  host.jobs.push(gate);
  publish(host, gate, "floor.json", floor, `own-shell-floor-${value.executorSha}-30-1`, 1);
  return floor;
}
function restoreEnvironment(original: Record<string, string | undefined>): void {
  for (const [name, previous] of Object.entries(original)) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("controller trust binds every imported module and dependency manifest", async () => {
  await fixture(async (value) => {
    assert.equal(controllerInputs(value.root, value.executorSha).length, 8);
    const binding: MainDispatchBinding = value.raw.selected;
    assertControllerTrust(value.root, binding);
    assert.notDeepEqual(
      controllerInputs(value.root, value.sourceSha),
      controllerInputs(value.root, value.executorSha),
    );
  });
});
