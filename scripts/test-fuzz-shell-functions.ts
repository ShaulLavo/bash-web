import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  coverage,
  defaultCount,
  defaultTimeoutMs,
  environment,
  execute,
  families,
  fingerprint,
  generateCases,
  generatedValues,
  generatedVariants,
  healthy,
  matches,
  matrixCases,
  maxGeneratedCount,
  optionsFor,
  outputLimit,
  render,
  run,
  sourceFiles,
  sourceHashes,
  validateFixture,
  values,
  valueVariants,
  variants,
} from "./fuzz-shell-functions.ts";

import type { FuzzFixture, RecordedCase } from "./fuzz-shell-results.ts";
type Case = ReturnType<typeof generateCases>[number];
type Fixture = FuzzFixture<Case>;

const options = { seed: 1, count: 0, timeoutMs: defaultTimeoutMs };
const path = "shell-functions-seed-1.json";
const fixtureHashes: Record<string, string> = {
  1: "30a63172f071c9ffc08348bf9c7e41fa59ee2c8a18245c91712298ef8434c7c0",
  42: "5bf569081490a4d4833794a7a5302d078bb371768ecdc07c51ba8c42d1c4d24a",
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

test("finite deterministic functions grammar keeps fixed cases separate from seeded semantic tuples", () => {
  const matrix = matrixCases();
  assert.equal(matrix.length, 198);
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed);
    assert.deepEqual(cases, generateCases(seed));
    assert.deepEqual(cases.slice(0, matrix.length), matrix);
    assert.equal(cases.length, matrix.length + defaultCount);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.equal(new Set(cases.map((item) => item.script)).size, cases.length);
    for (const item of cases) {
      assert.equal(item.script, render(item));
      assert.ok(item.script.length < 1800);
      assert.ok(!Object.hasOwn(item, "skip"));
      assert.ok(!Object.hasOwn(item, "unsupported"));
      assert.ok(!/\b(?:sleep|bash|mkfifo|timeout|trap)\b|\$\((?!\()|`|\$\$/.test(item.script));
      assert.ok(
        !/\bdeclare\b|\blocal -[aAinI]|\+=/.test(item.script),
        "no later declaration/integer/array prerequisites",
      );
      assert.ok(
        !/(?:^|[;{])\s*local\s*;/.test(item.script),
        "bare-local listing is a later declaration prerequisite",
      );
      assert.ok(
        item.script.endsWith(
          'fn_status=$?; printf "status=%s\\n" "$fn_status"; exit "$fn_status"\n',
        ),
      );
    }
    for (const item of cases.slice(matrix.length)) {
      assert.ok(generatedValues.includes(item.value));
      assert.ok(!values.includes(item.value));
      assert.ok(
        generatedVariants.some(
          ([family, variant]) => item.family === family && item.variant === variant,
        ),
      );
      assert.ok(item.script.includes('"$fn_value"'), "generated value must feed shell behavior");
    }
  }
  assert.notDeepEqual(generateCases(1), generateCases(42));
  assert.notDeepEqual(generateCases(0), generateCases(1));
  const scripts = new Set(
    generateCases(1)
      .slice(matrix.length)
      .map((item) => item.script),
  );
  assert.ok(
    generateCases(42)
      .slice(matrix.length)
      .filter((item) => scripts.has(item.script)).length < 12,
  );
  const all = generateCases(1, maxGeneratedCount);
  assert.equal(maxGeneratedCount, generatedVariants.length * generatedValues.length);
  assert.equal(new Set(all.map((item) => item.script)).size, all.length);
  assert.throws(() => generateCases(-1), /seed/);
  assert.throws(() => generateCases(1, maxGeneratedCount + 1), /count/);
  assert.throws(() => render({ family: "local", variant: "unknown", value: "" }), /specification/);
  assert.throws(
    () =>
      render(
        Object.assign({ family: "local", variant: "dynamic", value: "" }, { value: undefined }),
      ),
    /specification/,
  );
});

test("fixed matrix covers every scalar unit dimension without inert value padding", () => {
  const cases = matrixCases();
  assert.deepEqual(coverage(cases).families, families.toSorted());
  for (const [family, members] of Object.entries(variants))
    for (const variant of members) {
      const found = cases.filter((item) => item.family === family && item.variant === variant);
      assert.deepEqual(
        found.map((item) => item.value),
        valueVariants.has(family + "/" + variant) ? values : [values[0]],
      );
    }
  const script = (family: string, variant: string) => {
    const item = cases.find((item) => item.family === family && item.variant === variant);
    assert.ok(item, `${family}/${variant} must exist`);
    return item.script;
  };
  assert.ok(script("local", "dynamic").includes('local x="$fn_value"; g;'));
  assert.ok(script("local", "redeclaration").includes("local x;"));
  assert.ok(script("local", "export").includes('local -x x="$fn_value";'));
  assert.ok(script("local", "readonly").includes('local -r x="$fn_value";'));
  assert.ok(script("prefix", "multiple").includes('x="$fn_value" y="$x" f "$x:$y"'));
  assert.ok(script("prefix", "return").includes("return 7;"));
  assert.throws(() => optionsFor(["--unit-only"]));
  assert.ok(script("state", "async").includes('wait "$fn_pid"'));
  assert.ok(script("state", "lastpipe").includes("shopt -s lastpipe; g | f"));
  assert.ok(script("state", "pipeline-left").includes("while IFS= read -r fn_line;"));
  assert.ok(script("arguments", "zero").includes('test "$0" = "$fn_zero"'));
  assert.ok(script("arguments", "nested").includes('g "$fn_value"'));
  assert.ok(script("arguments", "recursive").includes('f "$((n-1))"'));
  assert.ok(script("positionals", "set").includes('set -- "$fn_value"'));
  assert.ok(script("return", "large").includes("return 9223372036854775807"));
  assert.ok(script("return", "overflow").includes("return 9223372036854775808"));
  assert.ok(script("prefix", "argument-expansion").includes('x="$fn_value" f "$x"'));
  assert.equal(
    environment.comparison,
    "stdout bytes and exit status; stderr retained as diagnostics, not compared",
  );
});

test("all transitive process-runner sources participate in fixture identity", () => {
  assert.deepEqual(sourceFiles, [
    "fuzz-shell-functions.ts",
    "fuzz-shell-control-flow.mjs",
    "fuzz-shell-results.ts",
    "shell-process-group.ts",
  ]);
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
});

test("strict status/stdout health rejects unsupported, timeout and partial-output exemptions", () => {
  assert.ok(matches(observation(), observation()));
  assert.ok(matches(observation({ status: 255 }), observation({ status: 255 })));
  assert.ok(
    matches(
      observation({ stdout: Buffer.from([0, 255]) }),
      observation({ stdout: Buffer.from([0, 255]) }),
    ),
  );
  for (const patch of [
    { status: 1 },
    { stdout: Buffer.from("ok") },
    { stdout: Buffer.from("ok\nextra\n") },
    { signal: "SIGKILL" },
    { timedOut: true },
    { error: "ETIMEDOUT" },
    {
      status: 2,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("shell-engine: unsupported syntax\n"),
    },
  ])
    assert.equal(matches(observation(), observation(patch)), false);
  for (const status of [-1, 256, null, 1.5]) assert.equal(healthy(observation({ status })), false);
  assert.equal(healthy(observation({ status: 127 })), true);
});

test("fixture validation rejects every identity and unhealthy-observation mutation", () => {
  assert.deepEqual(validateFixture(path, fixtureFor(), options), matrixCases());
  const mutations: ((fixture: Fixture) => unknown)[] = [
    (f) => f.schema++,
    (f) => (f.sourceHash = "stale"),
    (f) => (f.sourceHashes["fuzz-shell-functions.ts"] = "stale"),
    (f) => (f.sourceHashes["fuzz-shell-control-flow.mjs"] = "stale"),
    (f) => (f.sourceHashes["shell-process-group.ts"] = "stale"),
    (f) => (f.bash = "GNU bash, version 5.2.0"),
    (f) => (f.oraclePath = "/bin/bash"),
    (f) => (f.environment = { ...environment, locale: "C.UTF-8" }),
    (f) => (f.environment = { ...environment, shellArgs: ["--posix", "-c", "SCRIPT"] }),
    (f) => (f.provenance = "inferred"),
    (f) => (f.seed = 42),
    (f) => f.count++,
    (f) => f.timeoutMs++,
    (f) => (f.coverage = {}),
    (f) => f.cases.pop(),
    (f) => f.cases.reverse(),
    (f) => (f.cases[0].case.script += "true\n"),
    (f) => f.cases[0].case.tags.push("skip"),
    (f) => (f.cases[0].case.variant = "another"),
    (f) => (f.cases[0].case.value = "another"),
    (f) => (f.cases[1] = structuredClone(f.cases[0])),
    (f) => (f.cases[0].bash.status = null),
    (f) => (f.cases[0].bash.signal = "SIGKILL"),
    (f) => (f.cases[0].bash.timedOut = true),
    (f) => (f.cases[0].bash.error = "ENOBUFS"),
    (f) => (f.cases[0].bash.stdoutBase64 = "not base64"),
    (f) => (f.cases[0].bash.stderrBase64 = Buffer.alloc(outputLimit + 1).toString("base64")),
  ];
  for (const mutate of mutations) {
    const fixture = fixtureFor();
    mutate(fixture);
    assert.throws(() => validateFixture(path, fixture, options));
  }
  assert.throws(() => validateFixture("other.json", fixtureFor(), options), /filename/);
  assert.throws(
    () => validateFixture("shell-functions-seed-42.json", fixtureFor(), options),
    /filename/,
  );
  assert.throws(
    () => validateFixture(path, fixtureFor(), { ...options, seed: 42, explicitSeed: true }),
    /seed/,
  );
});

test("CLI enforces finite count, seed, timeout and exclusive capture/replay controls", () => {
  assert.equal(optionsFor([]).count, defaultCount);
  assert.equal(optionsFor(["--count=3"]).count, 3);
  assert.equal(optionsFor(["--seed", "0"]).seed, 0);
  assert.equal(optionsFor(["--replay", "a", "--replay", "b"]).replays.length, 2);
  for (const args of [
    ["--count", String(maxGeneratedCount + 1)],
    ["--count", "-1"],
    ["--count", "1.5"],
    ["--seed", "-1"],
    ["--seed", "4294967296"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "30001"],
    ["--record-oracle", "a", "--replay", "b"],
    ["--self-control", "--shell", "/usr/bin/bash"],
    ["--record", "a", "--record-oracle", "b"],
    ["--unknown", "x"],
  ])
    assert.throws(() => optionsFor(args));
});

test("shared runner drains timed-out descendants and leaves no per-process scratch", async () => {
  const parent = process.env.FUZZ_JOB_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp";
  const scratch = mkdtempSync(resolve(parent, "functions-test-"));
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    process.exitCode = 130;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await run("/usr/bin/bash", "while :; do :; done & wait", {
      cwd: scratch,
      timeoutMs: 60,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.error, "ETIMEDOUT");
    assert.deepEqual(readdirSync(scratch), []);
    assert.equal(interrupted, false, "interrupted after in-flight process-group teardown");
    const next = await run("/usr/bin/bash", "printf 'recovered\\n'", {
      cwd: scratch,
      timeoutMs: 2000,
    });
    assert.ok(healthy(next));
    assert.equal(next.stdout.toString(), "recovered\n");
    assert.deepEqual(readdirSync(scratch), []);
    const replay = await execute(
      [{ id: "replay-control", family: "control", script: "printf 'recovered\\n'" }],
      { cwd: scratch, timeoutMs: 2000 },
      "/usr/bin/bash",
      [
        {
          bash: {
            status: 0,
            signal: null,
            timedOut: false,
            error: null,
            stdoutBase64: Buffer.from("recovered\n").toString("base64"),
            stderrBase64: "",
          },
        },
      ],
    );
    assert.deepEqual(replay.counts, { MATCH: 1, MISMATCH: 0 });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    rmSync(scratch, { recursive: true, force: true });
  }
});

for (const seed of [1, 42])
  test(`frozen Bash seed ${seed} preserves exact unit observations and independent cases`, () => {
    const fixturePath = new URL(`./fixtures/shell-functions-seed-${seed}.json`, import.meta.url);
    const bytes = readFileSync(fixturePath);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      fixtureHashes[seed],
      "frozen oracle content requires explicit identity review",
    );
    const fixture: Fixture = JSON.parse(bytes.toString("utf8"));
    validateFixture(fixturePath.pathname, fixture, { ...options, count: defaultCount });
    assert.equal(fixture.provenance, "oracle-only");
    assert.equal(fixture.cases.length, matrixCases().length + defaultCount);
    assert.equal(
      new Set(fixture.cases.map((entry) => entry.case.script)).size,
      fixture.cases.length,
    );
    const pick = (family: string, variant: string, value = values[0]) => {
      const entry = fixture.cases.find(
        (entry) =>
          entry.case.family === family &&
          entry.case.variant === variant &&
          entry.case.value === value,
      );
      assert.ok(entry, `${family}/${variant} must exist`);
      return entry;
    };
    const stdout = (entry: RecordedCase<Case> | undefined) => {
      assert.ok(entry, "requested frozen observation must exist");
      return Buffer.from(entry.bash.stdoutBase64, "base64").toString();
    };
    assert.equal(
      stdout(pick("local", "dynamic", "a b")),
      "g=<a b>\nf=<changed>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("local", "shadow", "a b")),
      "g=<inner>\nf=<a b>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("local", "uninitialized")),
      "initial=<unset>\nlocal=<>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("local", "unset", "a b")),
      "before-unset=<a b>\ng-set=<outer>\nf-set=<outer>\nouter=<again>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("local", "unset-bare", "a b")),
      "bare=<unset>\nexposed=<>\nredeclared=<a b>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("local", "unset-redeclare", "a b")),
      "before=<a b>\nredeclared=<unset>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("local", "nested-unset", "a b")),
      "before=<a b>\nonce=<a b>\ntwice=<outer>\ng=<outer>\nf=<outer>\nouter=<outer>\nstatus=0\n",
    );
    for (const variant of [
      "ordinary",
      "subshell",
      "async",
      "pipeline-left",
      "pipeline-right",
      "lastpipe",
    ])
      assert.equal(
        stdout(pick("state", variant, "a b")),
        `inside=<a b>\nouter=<${["ordinary", "lastpipe"].includes(variant) ? "a b" : "outer"}>\nouter-count=1\nouter-arg=<parent>\nstatus=0\n`,
      );
    for (const variant of ["positive", "plus", "leading-zero", "space"]) {
      const entry = pick("funcnest", variant);
      assert.equal(entry.bash.status, 1);
      assert.equal(stdout(entry), "enter=3\nenter=2\n");
      assert.match(
        Buffer.from(entry.bash.stderrBase64, "base64").toString(),
        /maximum function nesting level exceeded \(2\)/,
      );
    }
    for (const variant of ["zero", "negative", "invalid"])
      assert.equal(
        stdout(pick("funcnest", variant)),
        "enter=3\nenter=2\nenter=1\nenter=0\nleave=0\nleave=1\nleave=2\nleave=3\ncall=0\nenter=0\nleave=0\nrecovered=0\nstatus=0\n",
      );
    assert.equal(
      stdout(pick("arguments", "zero")),
      "zero=preserved\nf-count=1\nf-arg=<>\nstatus=0\n",
    );
    for (const [variant, status] of [
      ["last-status", 1],
      ["explicit", 7],
      ["negative", 255],
      ["wrapped", 2],
      ["plus", 0],
      ["large", 255],
    ] as const) {
      const entry = pick("return", variant);
      assert.equal(entry.bash.status, status);
      assert.equal(stdout(entry), `status=${status}\n`);
    }
    for (const variant of ["invalid", "overflow"]) {
      const entry = pick("return", variant);
      assert.equal(stdout(entry), "call=2\ncontinued\nstatus=0\n");
      assert.match(
        Buffer.from(entry.bash.stderrBase64, "base64").toString(),
        /numeric argument required/,
      );
    }
    assert.equal(stdout(pick("return", "many")), "");
    assert.equal(pick("return", "many").bash.status, 1);
    assert.equal(stdout(pick("positionals", "shift-many")), "");
    assert.equal(pick("positionals", "shift-many").bash.status, 1);
    assert.equal(stdout(pick("return", "outside")), "outside=2\ncontinued\nstatus=0\n");
    assert.equal(
      stdout(pick("prefix", "restore", "a b")),
      "inside=<a b>\nouter=<outer>\nshared=<a b>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "argument-expansion", "a b")),
      "inside=<a b>\nf-count=1\nf-arg=<outer>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "new-name", "a b")),
      "inside=<a b>\nouter=<unset>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "export", "a b")),
      "prefix=<a b>\ninside=<written>\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "export-unset", "a b")),
      "prefix=<a b>\ninside=<written>\nouter=<unset>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "readonly-inner")),
      "inside=<temporary>\nrestored=<outer>\nmutable=<changed>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "multiple", "a b")),
      "inside-x=<a b>\ninside-y=<a b>\nf-count=1\nf-arg=<outer:outer-y>\nouter-x=<outer>\nouter-y=<outer-y>\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("prefix", "return", "a b")),
      "inside=<a b>\ncall=7\nouter=<outer>\nstatus=0\n",
    );
    assert.equal(stdout(pick("local", "export", "a b")), "inside=<a b>\nouter=<outer>\nstatus=0\n");
    const functionDescription = "f is a function\nf () \n{ \n    :\n}\n";
    assert.equal(
      stdout(pick("command", "function-V")),
      functionDescription + "query=0\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("command", "combined-options")),
      functionDescription + "printf is a shell builtin\nquery=0\nstatus=0\n",
    );
    assert.equal(stdout(pick("command", "multiple-v")), "f\nprintf\nquery=0\nstatus=0\n");
    assert.equal(
      stdout(pick("command", "multiple-V")),
      "printf is a shell builtin\n" + functionDescription + "query=0\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("command", "bypass-builtin", "a b")),
      "function=<a b>\na b\nstatus=0\n",
    );
    assert.equal(
      stdout(pick("command", "bypass-function", "a b")),
      "function=<a b>\nbypass=127\nstatus=0\n",
    );
    assert.equal(stdout(pick("command", "nested-command", "a b")), "a b\nstatus=0\n");
    assert.equal(stdout(pick("command", "default-path")), "builtin\nprintf\nquery=0\nstatus=0\n");
    for (const variant of ["unknown-v", "unknown-V", "missing-path-v", "missing-path-V"])
      assert.equal(stdout(pick("command", variant)), "query=1\nstatus=0\n");
    for (const variant of ["no-args", "no-args-v", "no-args-V"])
      assert.equal(stdout(pick("command", variant)), "empty=0\nstatus=0\n");
    assert.equal(stdout(pick("command", "invalid-option")), "option=2\nstatus=0\n");
    assert.equal(stdout(pick("command", "unknown-execute")), "unknown=127\nstatus=0\n");
    assert.equal(stdout(pick("command", "keyword-v")), "if\nfor\nwhile\nquery=0\nstatus=0\n");
    assert.equal(
      stdout(pick("command", "keyword-V")),
      "if is a shell keyword\nfor is a shell keyword\nwhile is a shell keyword\nquery=0\nstatus=0\n",
    );
  });
