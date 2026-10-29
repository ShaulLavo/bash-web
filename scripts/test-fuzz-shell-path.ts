import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  coverage,
  defaultCount,
  defaultTimeoutMs,
  environment,
  execute,
  families,
  filesystem,
  fingerprint,
  fixtureEnvironmentKey,
  fixtureManifest,
  generateCases,
  generatedPaths,
  generatedValues,
  healthy,
  matches,
  matrixCases,
  manifestLimits,
  parseManifest,
  validateManifest,
  maxGeneratedCount,
  optionsFor,
  outputLimit,
  probe,
  provision,
  removeSandbox,
  render,
  run,
  searchPaths,
  scratchParent,
  selectedDirectories,
  sourceFiles,
  sourceHashes,
  validateFixture,
  variants,
} from "./fuzz-shell-path.ts";

const parent = scratchParent();
import type { FuzzFixture } from "./fuzz-shell-results.ts";
type Case = ReturnType<typeof generateCases>[number];
type Fixture = FuzzFixture<Case>;

const options = { seed: 1, count: 0, timeoutMs: defaultTimeoutMs };
const fixturePath = "shell-path-seed-1.json";
const fixtureHashes: Record<string, string> = {
  "shell-path-seed-1.json": "f127475dc2b5551cce44f423b5fa3d3348b2bb4d2e50767bd39708e8a2d2f72e",
  "shell-path-seed-42.json": "fa30d34c6360015885b1fc54da7ac25667d95bd553797d00e93bef7a5b157461",
};
// Frozen before the manifest validator changed any harness source identity.
// These independently pin every case and Bash observation, excluding metadata.
const frozenCaseHashes: Record<string, string> = {
  "shell-path-seed-1.json": "eb1e52ed72dc626c8e974c2edd481dd97e766bd8d465ec1bbb640ffd7bb9c77a",
  "shell-path-seed-42.json": "641771a57e8156ee0b9cf5b7081f08bf979396b2452e2b349be2338ff3af47af",
};
const observation = (patch = {}) => ({
  status: 0,
  signal: null,
  timedOut: false,
  error: null,
  stdout: Buffer.from("ok\n"),
  stderr: Buffer.alloc(0),
  ...patch,
});
function fixtureFor(): Fixture {
  const cases = generateCases(1, 0);
  return {
    schema: 1,
    sourceHash: fingerprint(),
    sourceHashes: sourceHashes(),
    seed: 1,
    count: 0,
    timeoutMs: defaultTimeoutMs,
    bash: "GNU bash, version 5.3.15(1)-release (test)",
    oraclePath: "/usr/bin/bash",
    environment,
    provenance: "oracle-only",
    coverage: coverage(cases),
    cases: cases.map((item) => ({
      case: item,
      bash: {
        status: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdoutBase64: "",
        stderrBase64: "",
      },
    })),
  };
}
function scratch(t: import("node:test").TestContext) {
  // Existing: selected temporary root and shared runtimes/toolchains. This test owns
  // only its oracle-test-* directory and run()'s bounded process descendants.
  mkdirSync(parent, { recursive: true });
  const path = mkdtempSync(resolve(parent, "oracle-test-"));
  t.after(() => {
    removeSandbox(path);
    assert.equal(existsSync(path), false);
  });
  return path;
}

test("scratch roots use explicit job storage, runner storage or the platform temporary directory", () => {
  const runner = resolve(tmpdir(), "runner-storage");
  const job = resolve(tmpdir(), "job-storage");
  assert.equal(scratchParent({}), tmpdir());
  assert.equal(scratchParent({ RUNNER_TEMP: runner }), runner);
  assert.equal(scratchParent({ RUNNER_TEMP: runner, FUZZ_JOB_SCRATCH: job }), job);
});

test("finite PATH grammar is deterministic, unique and bounded for every seed", () => {
  const matrix = matrixCases();
  assert.equal(matrix.length, 156);
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed);
    assert.deepEqual(cases, generateCases(seed));
    assert.deepEqual(cases.slice(0, matrix.length), matrix);
    assert.equal(cases.length, matrix.length + defaultCount);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.equal(new Set(cases.map((item) => item.script)).size, cases.length);
    for (const item of cases) {
      assert.equal(item.script, render(item));
      assert.ok(item.script.length < 1100);
      assert.ok(
        item.script.endsWith(
          'path_status=$?; command printf "status=%s\\n" "$path_status"; exit "$path_status"\n',
        ),
      );
      assert.ok(!Object.hasOwn(item, "skip"));
      assert.ok(!Object.hasOwn(item, "unsupported"));
      assert.ok(!/\b(?:sleep|timeout|trap|bash|chmod|mkdir|rm)\b|`|\$\$/.test(item.script));
    }
    for (const item of cases.slice(matrix.length)) {
      assert.equal(item.variant, "generated");
      assert.ok(item.path !== undefined);
      assert.ok(generatedPaths.includes(item.path));
      assert.ok(
        selectedDirectories[searchPaths.indexOf(item.path)] !== null,
        "generated arguments reach an executable",
      );
      assert.ok(generatedValues.includes(item.value));
      assert.ok(item.script.includes(probe));
      assert.ok(
        item.script.includes("tail arg"),
        "generated values are actual executable arguments",
      );
    }
  }
  assert.notDeepEqual(generateCases(1), generateCases(42));
  const all = generateCases(1, maxGeneratedCount);
  assert.equal(maxGeneratedCount, generatedValues.length * generatedPaths.length);
  assert.equal(new Set(all.map((item) => item.script)).size, all.length);
  for (const seed of [-1, 0x100000000, NaN]) assert.throws(() => generateCases(seed), /seed/);
  for (const count of [-1, 0.5, maxGeneratedCount + 1])
    assert.throws(() => generateCases(1, count), /count/);
  assert.throws(
    () => render({ family: "search", variant: "generated", value: "x", path: "unregistered" }),
    /path/,
  );
  assert.throws(
    () => render({ family: "search", variant: "unknown", value: "x" }),
    /specification/,
  );
  assert.throws(
    () =>
      render(
        Object.assign({ family: "search", variant: "path-0", value: "" }, { value: undefined }),
      ),
    /specification/,
  );
});

test("fixed matrix covers empty entries, cwd, precedence, slash names and query search ordering", () => {
  const cases = matrixCases();
  assert.deepEqual(coverage(cases).families, families.toSorted());
  assert.equal(selectedDirectories.length, searchPaths.length);
  for (const [family, members] of Object.entries(variants))
    for (const variant of members) {
      if (variant !== "generated")
        assert.ok(
          cases.some((item) => item.family === family && item.variant === variant),
          family + "/" + variant,
        );
    }
  for (const index of searchPaths.keys()) {
    const entries = cases.filter(
      (item) => item.family === "search" && item.variant === "path-" + index,
    );
    assert.deepEqual(
      entries.map((item) => item.query),
      [undefined, "-v", "-V"],
    );
  }
  for (const path of [
    "",
    ":path-a",
    "path-a:",
    "missing::path-a",
    "./path-a",
    "path-b/../path-a",
    "path-noexec:path-b",
    "path-dir:path-b",
    "path-denied:path-b",
    "path-file:path-b",
  ])
    assert.ok(searchPaths.includes(path));
  for (const label of [
    "search/unset",
    "cwd/change-after-query",
    "precedence/command-bypass",
    "precedence/prefix-restored",
    "slash/not-directory",
    "query/unset-v",
    "query/absolute-V",
    "query/slash-nonexec-v",
    "query/mixed-v",
    "query/all-missing-V",
  ])
    assert.ok(cases.some((item) => item.family + "/" + item.variant === label));
  assert.equal(
    environment.comparison,
    "stdout bytes and exit status; stderr retained as diagnostics, not compared",
  );
  assert.throws(() => optionsFor(["--unit-only"]));
  assert.throws(() => optionsFor(["--exclude", "denied"]));
  assert.throws(() => optionsFor(["--normalize", "paths"]));
});

test("portable manifest uses bounded owned nodes, exact permissions and explicit environment identity", (t) => {
  const fixture = scratch(t);
  provision(fixture);
  assert.equal(fixtureEnvironmentKey, "BASH_WEB_PATH_FIXTURE");
  assert.deepEqual(environment.filesystem, fixtureManifest);
  assert.equal(filesystem.length, 20);
  assert.equal(new Set(filesystem.map((node) => node.path)).size, filesystem.length);
  for (const node of filesystem) {
    assert.ok(!node.path.startsWith("/") && !node.path.split("/").includes(".."));
    if (node.path.startsWith("path-denied/")) continue;
    assert.equal(statSync(resolve(fixture, node.path)).mode & 0o777, node.mode);
    if (node.marker !== undefined) {
      assert.ok(
        node.status !== undefined &&
          Number.isInteger(node.status) &&
          node.status > 0 &&
          node.status <= 255,
      );
      assert.ok(readFileSync(resolve(fixture, node.path), "utf8").startsWith("#!/usr/bin/bash\n"));
    }
  }
  removeSandbox(fixture);
  assert.equal(existsSync(fixture), false);
});

test("custom manifest cleanup restores late denied ancestors without following external symlinks", (t) => {
  const manifest = JSON.stringify({
    schema: 1,
    nodes: [
      { path: "first", kind: "file", mode: 0o600 },
      { path: "custom", kind: "directory", mode: 0o000 },
      { path: "custom/locked", kind: "directory", mode: 0o000 },
      { path: "custom/locked/file", kind: "file", mode: 0o600 },
    ],
  });
  const denied = scratch(t);
  try {
    provision(denied, manifest);
    removeSandbox(denied);
    assert.equal(existsSync(denied), false);
  } finally {
    // Independent fallback is installed before provisioning so a regression in
    // the cleanup function under test cannot leave inaccessible test data.
    for (const relative of ["custom", "custom/locked"])
      if (existsSync(resolve(denied, relative))) chmodSync(resolve(denied, relative), 0o755);
    removeSandbox(denied);
  }

  const swapped = scratch(t);
  const external = scratch(t);
  mkdirSync(resolve(external, "locked"), { mode: 0o700 });
  const protectedFile = resolve(external, "locked/file");
  writeFileSync(protectedFile, "outside sandbox\n");
  provision(
    swapped,
    JSON.stringify({
      schema: 1,
      nodes: [
        { path: "custom", kind: "directory", mode: 0o755 },
        { path: "custom/locked", kind: "directory", mode: 0o755 },
      ],
    }),
  );
  rmSync(resolve(swapped, "custom"), { recursive: true });
  symlinkSync(external, resolve(swapped, "custom"), "dir");
  removeSandbox(swapped);
  assert.equal(existsSync(swapped), false);
  assert.equal(statSync(resolve(external, "locked")).mode & 0o777, 0o700);
  assert.equal(readFileSync(protectedFile, "utf8"), "outside sandbox\n");
});

test("manifest schema and limits reject the whole input before filesystem mutation", (t) => {
  const cwd = scratch(t);
  const valid = {
    schema: 1,
    nodes: [{ path: "first", kind: "file", mode: 0o755, marker: "ok", status: 7 }],
  };
  const invalidNodes = new Array<unknown>().concat(
    [
      { path: "", kind: "file", mode: 0o600 },
      { path: "x".repeat(manifestLimits.pathBytes + 1), kind: "file", mode: 0o600 },
      { path: "é".repeat(manifestLimits.pathBytes / 2 + 1), kind: "file", mode: 0o600 },
      { path: "\ud800", kind: "file", mode: 0o600 },
      { path: "\ud801", kind: "file", mode: 0o600 },
      { path: "\udfff", kind: "file", mode: 0o600 },
      { path: "first", kind: "file", mode: 0o600 },
      { path: "first/child", kind: "file", mode: 0o600 },
      { path: "missing/child", kind: "file", mode: 0o600 },
      null,
      {},
      { path: "invalid", kind: "link", mode: 0o755 },
      { path: "invalid", kind: "file", mode: -1 },
      { path: "invalid", kind: "file", mode: 0o1000 },
      { path: "invalid", kind: "file", mode: 1.5 },
      { path: "invalid", kind: "file", mode: 0o755, unknown: true },
      { path: "invalid", kind: "directory", mode: 0o755, marker: "ok", status: 7 },
    ],
    ["/absolute", "../escape", "a/../escape", "a//b", "a/./b", "trailing/", "nul\0", "line\n"].map(
      (path) => ({ path, kind: "file", mode: 0o600 }),
    ),
    [
      { marker: "ok" },
      { status: 7 },
      { marker: null, status: null },
      { marker: "ok", status: 0 },
      { marker: "ok", status: 256 },
      { marker: "ok", status: 1.5 },
      { marker: "", status: 7 },
      { marker: "bad\nmarker", status: 7 },
      { marker: "x".repeat(manifestLimits.markerBytes + 1), status: 7 },
    ].map((program) => ({ path: "invalid", kind: "file", mode: 0o755, ...program })),
  );
  for (const node of invalidNodes) {
    const manifest = { ...valid, nodes: Array.from<unknown>(valid.nodes).concat([node]) };
    assert.throws(() => provision(cwd, JSON.stringify(manifest)), JSON.stringify(node));
    assert.deepEqual(readdirSync(cwd), [], "no earlier valid node may be created");
  }
  for (const manifest of [
    null,
    [],
    {},
    { ...valid, schema: 2 },
    { ...valid, unknown: 1 },
    { ...valid, nodes: {} },
  ])
    assert.throws(() => validateManifest(manifest));
  const full = {
    schema: 1,
    nodes: Array.from({ length: manifestLimits.nodes }, (_, index) => ({
      path: "file-" + index,
      kind: "file",
      mode: 0o600,
    })),
  };
  assert.deepEqual(parseManifest(JSON.stringify(full)), full);
  assert.throws(
    () =>
      parseManifest(
        JSON.stringify({
          ...full,
          nodes: full.nodes.concat([{ path: "overflow", kind: "file", mode: 0o600 }]),
        }),
      ),
    /oversized/,
  );
  const empty = JSON.stringify({ schema: 1, nodes: [] });
  assert.deepEqual(parseManifest(empty.padEnd(manifestLimits.bytes, " ")), {
    schema: 1,
    nodes: [],
  });
  assert.throws(() => parseManifest(empty.padEnd(manifestLimits.bytes + 1, " ")), /oversized/);
  assert.throws(
    () => parseManifest(" ".repeat(manifestLimits.bytes) + "not JSON"),
    /oversized/,
    "raw bound precedes JSON parsing",
  );
  assert.throws(() => parseManifest("{"), /JSON/);
  validateManifest({
    schema: 1,
    nodes: [
      {
        path: "x".repeat(manifestLimits.pathBytes),
        kind: "file",
        mode: 0o755,
        marker: "x".repeat(manifestLimits.markerBytes),
        status: 255,
      },
    ],
  });
});

test("all transitive harness sources are pinned and raw bytes/status stay strict", () => {
  const expected = ["fuzz-shell-path.ts"].concat([
    "fuzz-shell-control-flow.mjs",
    "fuzz-shell-results.ts",
    "shell-process-group.ts",
  ]);
  assert.deepEqual(sourceFiles, expected);
  for (const [name, hash] of Object.entries(sourceHashes()))
    assert.equal(
      hash,
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    );
  assert.equal(
    fingerprint(),
    createHash("sha256").update(JSON.stringify(sourceHashes())).digest("hex"),
  );
  assert.ok(matches(observation(), observation()));
  assert.ok(matches(observation({ status: 127 }), observation({ status: 127 })));
  assert.ok(
    matches(
      observation({ stdout: Buffer.from([0, 255]) }),
      observation({ stdout: Buffer.from([0, 255]) }),
    ),
  );
  assert.ok(
    matches(
      observation(),
      observation({ stderr: Buffer.from("diagnostics differ, retained only\n") }),
    ),
  );
  for (const patch of [
    { status: 1 },
    { stdout: Buffer.from("ok") },
    { signal: "SIGKILL" },
    { timedOut: true },
    { error: "ETIMEDOUT" },
    { status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("unsupported syntax\n") },
  ])
    assert.equal(matches(observation(), observation(patch)), false);
  for (const status of [-1, 256, null, 1.5]) assert.equal(healthy(observation({ status })), false);
});

test("fixture identity rejects schema, grammar, oracle, environment, subset and raw-byte mutations", () => {
  assert.deepEqual(validateFixture(fixturePath, fixtureFor(), options), matrixCases());
  const mutations: ((fixture: Fixture) => unknown)[] = [
    (f) => f.schema++,
    (f) => (f.sourceHash = "stale"),
    (f) => (f.sourceHashes["fuzz-shell-path.ts"] = "stale"),
    (f) => (f.sourceHashes["fuzz-shell-control-flow.mjs"] = "stale"),
    (f) => (f.sourceHashes["shell-process-group.ts"] = "stale"),
    (f) => (f.bash = "GNU bash, version 5.2.0"),
    (f) => (f.oraclePath = "/bin/bash"),
    (f) => (f.environment = { ...environment, filesystem: { schema: 1, nodes: [] } }),
    (f) => (f.provenance = "inferred"),
    (f) => (f.seed = -1),
    (f) => f.count++,
    (f) => f.timeoutMs++,
    (f) => (f.coverage = {}),
    (f) => f.cases.pop(),
    (f) => (f.cases[0].case.script += "\n:"),
    (f) => Object.assign(f.cases[0].case, { skip: true }),
    (f) => (f.cases[0].bash.status = 256),
    (f) => (f.cases[0].bash.signal = "SIGKILL"),
    (f) => (f.cases[0].bash.timedOut = true),
    (f) => (f.cases[0].bash.error = "EACCES"),
    (f) => (f.cases[0].bash.stdoutBase64 = "not-base64"),
    (f) => (f.cases[0].bash.stderrBase64 = "YQ"),
    (f) => (f.cases[0].bash.stdoutBase64 = Buffer.alloc(outputLimit + 1).toString("base64")),
  ];
  for (const mutate of mutations) {
    const fixture = structuredClone(fixtureFor());
    mutate(fixture);
    assert.throws(() => validateFixture(fixturePath, fixture, options));
  }
  assert.throws(
    () => validateFixture("shell-path-seed-42.json", fixtureFor(), options),
    /filename/,
  );
  assert.throws(
    () => validateFixture(fixturePath, fixtureFor(), { ...options, explicitSeed: true, seed: 42 }),
    /seed/,
  );
});

test("independent GNU Bash observations expose 126/127 and nonexec query fallback without output rewriting", async (t) => {
  const cwd = scratch(t);
  const controls = [
    ["search", "unset", 3, "marker=<cwd>\narg=<fixed argument>\narg=<tail arg>\nstatus=3\n"],
    ["search", "path-0", 3, "marker=<cwd>\narg=<fixed argument>\narg=<tail arg>\nstatus=3\n"],
    ["search", "path-17", 126, "status=126\n"],
    ["search", "path-18", 127, "status=127\n"],
    ["search", "path-19", 127, "status=127\n"],
    ["search", "path-20", 127, "status=127\n"],
    ["search", "path-21", 9, "marker=<b>\narg=<fixed argument>\narg=<tail arg>\nstatus=9\n"],
    ["search", "path-22", 9, "marker=<b>\narg=<fixed argument>\narg=<tail arg>\nstatus=9\n"],
    ["search", "path-26", 127, "status=127\n"],
    ["search", "path-28", 126, "status=126\n"],
    ["search", "path-29", 126, "status=126\n"],
    ["query", "nonexec-v", 0, `path-noexec/${probe}\nstatus=0\n`],
    ["query", "directory-v", 1, "status=1\n"],
    ["slash", "directory", 126, "status=126\n"],
    ["slash", "not-directory", 126, "status=126\n"],
    ["slash", "denied", 126, "status=126\n"],
    ["query", "absolute-v", 0, "query-exact=1\nstatus=0\n"],
    ["query", "absolute-V", 0, "query-exact=1\nstatus=0\n"],
    ["query", "unset-v", 0, "query-exact=1\nstatus=0\n"],
    ["query", "unset-V", 0, "query-exact=1\nstatus=0\n"],
  ] as const;
  for (const [family, variant, status, stdout] of controls) {
    const result = await run(
      "/usr/bin/bash",
      render({ family, variant, value: "fixed argument" }),
      { ...options, cwd },
    );
    assert.ok(healthy(result), family + "/" + variant);
    assert.equal(result.status, status, family + "/" + variant);
    assert.equal(result.stdout.toString(), stdout, family + "/" + variant);
    if ([126, 127].includes(status))
      assert.ok(result.stderr.length > 0, "raw diagnostic bytes retained");
    assert.deepEqual(readdirSync(cwd), [], "process tree removed after each observation");
  }
});

test("Bash rejects traversed file, denied and missing ancestors before lexical parent reduction", async (t) => {
  const cwd = scratch(t);
  for (const directory of ["path-file", "path-denied", "missing", "path-b"]) {
    const result = await run("/usr/bin/bash", `PATH=${directory}/../path-a; ${probe} x`, {
      ...options,
      cwd,
    });
    assert.ok(healthy(result), directory);
    assert.equal(result.status, directory === "path-b" ? 7 : 127, directory);
    assert.equal(
      result.stdout.toString(),
      directory === "path-b" ? "marker=<a>\narg=<x>\n" : "",
      directory,
    );
    assert.deepEqual(readdirSync(cwd), []);
  }
});

test("replay processes every case and counts unsupported, status and byte differences as failures", async (t) => {
  const cwd = scratch(t);
  const cases = [
    { id: "healthy", family: "search", script: "printf 'ok\\n'" },
    { id: "unsupported", family: "search", script: "printf 'unsupported syntax\\n' >&2; exit 2" },
    { id: "last", family: "query", script: "printf 'last\\n'; exit 127" },
  ];
  const recorded = cases.map(() => ({
    bash: {
      status: 0,
      signal: null,
      timedOut: false,
      error: null,
      stdoutBase64: Buffer.from("ok\n").toString("base64"),
      stderrBase64: "",
    },
  }));
  const result = await execute(cases, { ...options, cwd }, "/usr/bin/bash", recorded);
  assert.equal(result.total, 3);
  assert.deepEqual(result.counts, { MATCH: 1, MISMATCH: 2 });
  assert.equal(result.byFamily.query.MISMATCH, 1);
  assert.deepEqual(
    result.mismatches.map((item) => item.case.id),
    ["unsupported", "last"],
  );
  assert.deepEqual(readdirSync(cwd), []);
});

test("spawn failure, timeout, output limit and pre-interruption keep owned scratch clean", async (t) => {
  const cwd = scratch(t);
  const missing = await run(resolve(cwd, "absent-shell"), ":", { ...options, cwd });
  assert.equal(missing.error, "ENOENT");
  assert.equal(healthy(missing), false);
  assert.deepEqual(readdirSync(cwd), []);
  const timed = await run("/usr/bin/bash", "while :; do :; done", {
    ...options,
    cwd,
    timeoutMs: 20,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(healthy(timed), false);
  assert.deepEqual(readdirSync(cwd), []);
  const overflow = await run("/usr/bin/bash", "while :; do printf '%01000d' 0; done", {
    ...options,
    cwd,
  });
  assert.equal(overflow.error, "ENOBUFS");
  assert.equal(healthy(overflow), false);
  assert.deepEqual(readdirSync(cwd), []);
  await assert.rejects(
    run("/usr/bin/bash", ":", { ...options, cwd, interrupted: true }),
    /interrupted/,
  );
  assert.deepEqual(readdirSync(cwd), []);
});

test("every captured seed includes the full fixed matrix and all seeded observations", () => {
  const names = readdirSync(new URL("./fixtures/", import.meta.url)).filter((name) =>
    /^shell-path-seed-\d+\.json$/.test(name),
  );
  assert.deepEqual(names.sort(), ["shell-path-seed-1.json", "shell-path-seed-42.json"]);
  for (const name of names) {
    const bytes = readFileSync(new URL("./fixtures/" + name, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtureHashes[name]);
    const fixture: Fixture = JSON.parse(bytes.toString("utf8"));
    assert.equal(
      createHash("sha256").update(JSON.stringify(fixture.cases)).digest("hex"),
      frozenCaseHashes[name],
      "harness metadata updates must not change frozen cases or observations",
    );
    const cases = validateFixture(name, fixture, { ...options, count: defaultCount });
    assert.equal(cases.length, matrixCases().length + defaultCount);
    assert.equal(fixture.provenance, "oracle-only");
    assert.ok(fixture.cases.every((entry) => healthy(entry.bash)));
    for (const entry of fixture.cases)
      if (entry.case.script.includes("path_answer=$(")) {
        const stdout = Buffer.from(entry.bash.stdoutBase64, "base64").toString();
        assert.ok(
          stdout.startsWith("query-exact=1\n"),
          entry.case.id + " must satisfy its exact-answer predicate",
        );
        assert.ok(!stdout.includes("unexpected=<"));
      }
    for (const entry of fixture.cases)
      if (entry.case.variant === "generated") {
        const stdout = Buffer.from(entry.bash.stdoutBase64, "base64").toString();
        assert.ok(stdout.startsWith("marker=<"));
        assert.ok(
          stdout.includes("arg=<" + entry.case.value + ">\n"),
          entry.case.id + " must deliver its seeded argument",
        );
      }
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 126));
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 127));
    assert.ok(
      fixture.cases.some((entry) => Buffer.from(entry.bash.stderrBase64, "base64").length > 0),
    );
  }
});
