import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import {
  assertMainRun,
  assertUploader,
  artifactJson,
  authority,
  firstParent,
  git,
  scoreEquivalenceInputs,
  scoreInput,
  scoreJobSlice,
  scoringInputs,
  sourceEquivalent,
} from "./shell-scoreboard-main.ts";
import { bytesDigest } from "./shell-scoreboard.ts";

import { archive, provenance, sha, withRepo } from "./shell-scoreboard-main-test-fixture.ts";
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
// Main run 41286577653, job 124792323892: the upload step and its log ran at 08:10:4xZ, but the host
// recorded artifact 13076280499 at 09:10:44Z, in the repeated 01:00-02:00 Pacific hour of 2026-11-01.
function repeatedHourUpload(createdAt: string) {
  const input = provenance();
  for (const step of input.job.steps) {
    step.started_at = "2026-11-01T08:10:43Z";
    step.completed_at = "2026-11-01T08:10:44Z";
  }
  input.artifact.created_at = createdAt;
  input.logs = input.logs.replaceAll("2026-10-24T17:00:01", "2026-11-01T08:10:44");
  return input;
}
test("a host time in the repeated 2026-11-01 Pacific hour may denote the instant an hour earlier", () => {
  assert.equal(assertUploader(repeatedHourUpload("2026-11-01T09:10:44Z")).artifactId, 30);
  assert.equal(assertUploader(repeatedHourUpload("2026-11-01T08:10:44Z")).artifactId, 30);
  for (const createdAt of [
    "2026-11-01T09:10:45Z",
    "2026-11-01T09:10:42Z",
    "2026-11-01T10:10:44Z",
    "2026-11-01T07:10:44Z",
  ])
    assert.throws(
      () => assertUploader(repeatedHourUpload(createdAt)),
      /artifact is outside this upload step/,
    );
  const later = repeatedHourUpload("2026-11-01T10:10:44Z");
  for (const step of later.job.steps) {
    step.started_at = "2026-11-01T09:10:43Z";
    step.completed_at = "2026-11-01T09:10:44Z";
  }
  later.logs = later.logs.replaceAll("2026-11-01T08:10:44", "2026-11-01T09:10:44");
  assert.throws(() => assertUploader(later), /artifact is outside this upload step/);
  const nextYear = provenance();
  for (const step of nextYear.job.steps) {
    step.started_at = "2027-11-07T08:10:43Z";
    step.completed_at = "2027-11-07T08:10:44Z";
  }
  nextYear.artifact.created_at = "2027-11-07T09:10:44Z";
  nextYear.logs = nextYear.logs.replaceAll("2026-10-24T17:00:01", "2027-11-07T08:10:44");
  assert.throws(() => assertUploader(nextYear), /artifact is outside this upload step/);
});
test("a successfully uploaded regression receipt stays authoritative, never green", () => {
  const input = provenance("floor");
  input.job.conclusion = "failure";
  input.job.steps.push({
    name: "Enforce qualification",
    number: 3,
    status: "completed",
    conclusion: "failure",
    started_at: "2026-10-24T17:00:02Z",
    completed_at: "2026-10-24T17:00:03Z",
  });
  assert.doesNotThrow(() => assertUploader(input));
  input.job.steps[2].name = "Some broken validation";
  assert.throws(() => assertUploader(input), /unexpected failed producer/);
});
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
  ] satisfies [string, string][][]) {
    const bad = archive(entries);
    assert.throws(() => artifactJson(bad, { digest: `sha256:${bytesDigest(bad)}` }, "raw.json"));
  }
});
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

/** A small ci.yml with the four score jobs, what they need, and an unrelated browser job. */
function scoreWorkflow(edit: { scoreboard?: string; native?: string; browser?: string } = {}) {
  return [
    "name: CI",
    "jobs:",
    "  prepare:",
    "    runs-on: ubuntu-latest",
    "    steps: [{ run: node scripts/ci/ci-inputs.ts }]",
    "  native:",
    "    needs: prepare",
    `    steps: [{ uses: ./.github/actions/wasi-sdk }, { run: "${edit.native ?? "cargo build"}" }]`,
    "  own-shell-scoreboard:",
    "    needs: [prepare, native]",
    "    steps:",
    "      - run: bash .github/scripts/use-main-ubuntu-archive.sh",
    `      - run: "${edit.scoreboard ?? "node scripts/scoreboard/scoreboard-tests.ts"}"`,
    "  own-shell-observation:",
    "    needs: [prepare, native]",
    "    steps: [{ run: npm run compat:shell:prebuilt }]",
    "  own-shell-compatibility:",
    "    needs: [own-shell-scoreboard, own-shell-observation]",
    "    steps: [{ run: node scripts/scoreboard/scoreboard-ci.ts compare }]",
    "  score-floor:",
    "    needs: own-shell-compatibility",
    "    steps: [{ run: node scripts/scoreboard/scoreboard-ci.ts floor }]",
    "  browser:",
    "    needs: [prepare, native]",
    `    steps: [{ run: bash .github/scripts/browser-only.sh }, { run: "${edit.browser ?? "npx playwright test"}" }]`,
    "",
  ].join("\n");
}

test("score equivalence ignores browser specs, unrelated tests and non-score CI", async () => {
  await withRepo(({ root, put, commit }) => {
    put(".github/workflows/ci.yml", scoreWorkflow());
    for (const path of [
      ".github/scripts/use-main-ubuntu-archive.sh",
      ".github/scripts/browser-only.sh",
      ".github/actions/wasi-sdk/action.yml",
      "shell/engine/src/lib.rs",
      "scripts/compat/bash-compat.ts",
      "scripts/scoreboard/scoreboard-tests.ts",
      "scripts/test-own-shell-echo.ts",
      "scripts/ci/test-ci-workflow.ts",
      "tests/shell.spec.ts",
      "tests/navigate-test-page.unit.ts",
      "tests/helpers/readiness.ts",
      "tests/browser-main.ts",
      "src/runtime/storage.test.ts",
      "tests/python.spec.ts",
    ])
      put(path, "a");
    let previous = commit();
    const unchanged = (change: () => void) => {
      change();
      const next = commit();
      assert.equal(sourceEquivalent(root, previous, next), true);
      previous = next;
    };
    unchanged(() => put("tests/shell.spec.ts", "b"));
    unchanged(() => put("tests/navigate-test-page.unit.ts", "b"));
    unchanged(() => put("tests/helpers/readiness.ts", "b"));
    unchanged(() => put("tests/browser-main.ts", "b"));
    unchanged(() => put("src/runtime/storage.test.ts", "b"));
    unchanged(() => put("scripts/ci/test-ci-workflow.ts", "b"));
    unchanged(() => put(".github/scripts/browser-only.sh", "b"));
    unchanged(() => put(".github/workflows/ci.yml", scoreWorkflow({ browser: "npx playwright" })));
    // Reformatting the workflow without changing what the score jobs do keeps the score.
    unchanged(() =>
      put(".github/workflows/ci.yml", `# comment\n${scoreWorkflow({ browser: "npx playwright" })}`),
    );
  });
});

test("score equivalence still breaks on shell, scorer, score tests and score-job CI", async () => {
  await withRepo(({ root, put, commit }) => {
    put(".github/workflows/ci.yml", scoreWorkflow());
    for (const path of [
      ".github/scripts/use-main-ubuntu-archive.sh",
      ".github/actions/wasi-sdk/action.yml",
      "shell/engine/src/lib.rs",
      "scripts/compat/bash-compat.ts",
      "scripts/scoreboard/scoreboard-tests.ts",
      "scripts/test-own-shell-echo.ts",
      "tests/python.spec.ts",
      "tests/helpers/python-cases.ts",
      "tests/guest/src/main.rs",
      "src/runtime/storage.ts",
      "package-lock.json",
    ])
      put(path, "a");
    const base = commit();
    const changes: [string, () => void][] = [
      ["shell source", () => put("shell/engine/src/lib.rs", "b")],
      ["scorer", () => put("scripts/compat/bash-compat.ts", "b")],
      ["score-family test", () => put("scripts/test-own-shell-echo.ts", "b")],
      ["lock file", () => put("package-lock.json", "b")],
      ["test the score code runs", () => put("tests/python.spec.ts", "b")],
      ["helper the score code imports", () => put("tests/helpers/python-cases.ts", "b")],
      ["test guest program", () => put("tests/guest/src/main.rs", "b")],
      ["adapter source", () => put("src/runtime/storage.ts", "b")],
      ["toolchain action", () => put(".github/actions/wasi-sdk/action.yml", "b")],
      ["script a score job runs", () => put(".github/scripts/use-main-ubuntu-archive.sh", "b")],
      [
        "score-job step",
        () => put(".github/workflows/ci.yml", scoreWorkflow({ scoreboard: "node x.ts" })),
      ],
      [
        "job a score job needs",
        () => put(".github/workflows/ci.yml", scoreWorkflow({ native: "cargo build -j1" })),
      ],
      [
        "top-level env",
        () => put(".github/workflows/ci.yml", `env:\n  BASH_COMPAT_JOBS: 1\n${scoreWorkflow()}`),
      ],
      [
        "top-level defaults.run",
        () =>
          put(".github/workflows/ci.yml", `defaults:\n  run:\n    shell: sh\n${scoreWorkflow()}`),
      ],
    ];
    for (const [name, change] of changes) {
      git(root, ["checkout", "-q", "--detach", base]);
      change();
      assert.equal(sourceEquivalent(root, base, commit()), false, name);
    }
  });
});

test("the score job slice follows needs and fails on a missing score job", () => {
  const slice = JSON.parse(scoreJobSlice(scoreWorkflow())) as { name: string; jobs: object };
  assert.equal(slice.name, "CI");
  assert.deepEqual(Object.keys(slice.jobs), [
    "native",
    "own-shell-compatibility",
    "own-shell-observation",
    "own-shell-scoreboard",
    "prepare",
    "score-floor",
  ]);
  assert.throws(() => scoreJobSlice("jobs:\n  browser:\n    steps: []\n"));
});

test("source input filtering follows each commit's scoreboard layout", async () => {
  await withRepo(({ root, put, commit }) => {
    put(
      authority.workflowPath,
      scoreWorkflow({ scoreboard: "npm run test:shell:scoreboard:prebuilt" }),
    );
    const flatTest = "scripts/test-ci-workflow.ts";
    const groupedTest = "scripts/ci/test-ci-workflow.ts";
    const flatBrowserBuild = "scripts/build-product-shell-test.ts";
    const groupedBrowserBuild = "scripts/build/build-product-shell-test.ts";
    const replay = "scripts/replay/runtime/test-own-shell-exec.ts";
    for (const file of [flatTest, groupedTest, flatBrowserBuild, groupedBrowserBuild, replay])
      put(file, "fixture");
    put("scripts/scoreboard-tests.ts", "fixture");
    const historical = commit();
    put("scripts/scoreboard/scoreboard-tests.ts", "fixture");
    const current = commit();
    const includes = (sha: string, path: string) =>
      scoreEquivalenceInputs(root, sha).some((record) => record.endsWith(`\t${path}`));
    assert.equal(includes(historical, flatTest), false);
    assert.equal(includes(historical, flatBrowserBuild), false);
    assert.equal(includes(historical, groupedTest), true);
    assert.equal(includes(current, groupedTest), false);
    assert.equal(includes(current, groupedBrowserBuild), false);
    assert.equal(includes(current, replay), true);
  });
});

/** Expands `npm run <script>` in score-job commands through package.json, recursively. */
function scoreCommands(slice: string, scripts: Record<string, string>): string {
  const seen = new Set<string>();
  const pending = Array.from(slice.matchAll(/npm run ([\w:.-]+)/g), (match) => match[1]!);
  let text = slice;
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (seen.has(name) || !scripts[name]) continue;
    seen.add(name);
    text += `\n${scripts[name]}`;
    for (const match of scripts[name].matchAll(/npm run ([\w:.-]+)/g)) pending.push(match[1]!);
  }
  return text;
}

test("no score input or score-job command names a file the score rule ignores", () => {
  const root = resolve(import.meta.dirname, "../..");
  const head = git(root, ["rev-parse", "HEAD"]);
  const workflow = readFileSync(resolve(root, authority.workflowPath), "utf8");
  const slice = scoreJobSlice(workflow);
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const paths = scoringInputs(root, head).map((record) => record.slice(record.indexOf("\t") + 1));
  // The workflow itself is replaced by the score-job slice, not ignored.
  const ignored = paths.filter(
    (path) => path !== authority.workflowPath && !scoreInput(path, slice, true),
  );
  assert.ok(ignored.some((path) => path.startsWith("tests/") && path.endsWith(".spec.ts")));
  const kept = new Set(
    scoreEquivalenceInputs(root, head).map((record) => record.slice(record.indexOf("\t") + 1)),
  );
  // Scope: TypeScript under scripts/, src/ and tests/, plus the score jobs' commands.
  // These files name ignored files on purpose: as fixtures, and to classify them.
  const classifiers = new Set([
    "scripts/scoreboard/test-shell-scoreboard-main-inputs.ts",
    "scripts/scoreboard/shell-scoreboard-main.ts",
  ]);
  const referenced = new Map<string, string>();
  for (const path of kept) {
    if (classifiers.has(path) || !/^(?:scripts|src|tests)\/.+\.ts$/.test(path)) continue;
    for (const target of fileReferences(path, readFileSync(resolve(root, path), "utf8")))
      referenced.set(target, path);
  }
  const commands = scoreCommands(slice, packageJson.scripts);
  for (const match of commands.matchAll(/(?:scripts|src|tests|\.github)\/[\w./-]+/g))
    referenced.set(match[0], "a score job command");
  for (const path of ignored)
    assert.equal(
      referenced.get(path),
      undefined,
      `${path} is ignored but ${referenced.get(path)} uses it`,
    );
});

/** Repository paths a TypeScript file refers to: relative imports and URLs, and repo paths. */
function fileReferences(path: string, source: string): string[] {
  const directory = path.slice(0, path.lastIndexOf("/"));
  const literals = source.matchAll(/["'`]((?:\.{1,2}\/|(?:scripts|src|tests)\/)[^"'`\s$]+)["'`]/g);
  return Array.from(literals, (match) => {
    const target = match[1]!;
    if (!target.startsWith(".")) return [target];
    const resolved = relative(resolve("/"), resolve("/", directory, target));
    return [resolved, `${resolved}.ts`];
  }).flat();
}
