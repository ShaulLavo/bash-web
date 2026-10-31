import * as fuzzer from "./fuzz-shell-job-lifetime.ts";
import { observation, syntheticFixture } from "./fuzz-test-observation.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  coverage,
  defaultCount,
  defaultTimeoutMs,
  environment,
  families,
  fingerprint,
  generateCases,
  generatedStatuses,
  healthy,
  matches,
  matrixCases,
  maxGeneratedCount,
  optionsFor,
  outputLimit,
  parseFixture,
  render,
  scopes,
  sourceFiles,
  sourceHashes,
  statuses,
  validateFixture,
} from "./fuzz-shell-job-lifetime.ts";
import type { FuzzFixture as Fixture } from "./fuzz-shell-results.ts";
import type { Case } from "./fuzz-shell-job-lifetime.ts";

const options = { seed: 1, count: 0, timeoutMs: defaultTimeoutMs };
const path = "shell-job-lifetime-seed-1.json";

const fixtureFor = () => syntheticFixture(fuzzer);

test("generation is deterministic, independently seeded, finite and builtin-only", () => {
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed);
    assert.deepEqual(cases, generateCases(seed));
    assert.equal(cases.length, matrixCases().length + defaultCount);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.equal(new Set(cases.map((item) => item.script)).size, cases.length);
    assert.deepEqual(cases.slice(0, matrixCases().length), matrixCases());
    for (const item of cases.slice(matrixCases().length)) {
      assert.ok(generatedStatuses.includes(item.status));
      assert.ok(!statuses.includes(item.status));
    }
    assert.ok(cases.length < 300);
    for (const item of cases) {
      assert.equal(item.script, render(item));
      assert.ok(item.script.length < 1600);
      assert.ok(!/\b(?:sleep|sh|bash|cat|mkfifo|timeout)\b/.test(item.script), item.id);
      assert.ok(!/\$\(|`|\$\$/.test(item.script), item.id);
      assert.ok(!Object.hasOwn(item, "skip"));
      assert.ok(!Object.hasOwn(item, "unsupported"));
      assert.ok(
        item.script.endsWith(
          'jl_status=$?; printf "status=%s\\n" "$jl_status"; exit "$jl_status"\n',
        ),
      );
    }
  }
  assert.notDeepEqual(generateCases(1, 24), generateCases(42, 24));
  assert.notDeepEqual(generateCases(0, 24), generateCases(1, 24));
  assert.equal(generateCases(1, 3).length, matrixCases().length + 3);
  assert.throws(() => generateCases(-1), /seed/);
  assert.throws(() => generateCases(1, 10001), /count/);
  assert.throws(() => render({ family: "unknown", scope: "top", status: 0 }), /specification/);
});

test("generated stream has substantive cross-seed diversity and a finite unique capacity", () => {
  const stream = (seed: number) => generateCases(seed).slice(matrixCases().length);
  const first = stream(1);
  const second = stream(42);
  const firstScripts = new Set(first.map((item) => item.script));
  assert.ok(second.filter((item) => firstScripts.has(item.script)).length < 8);
  assert.ok(new Set(first.map((item) => item.status)).size > 60);
  assert.ok(new Set(second.map((item) => item.status)).size > 60);
  assert.deepEqual(
    generatedStatuses,
    Array.from({ length: 256 }, (_, status) => status).filter(
      (status) => !statuses.includes(status),
    ),
  );
  assert.equal(maxGeneratedCount, 9072);
  const complete = generateCases(1, maxGeneratedCount);
  assert.equal(complete.length, 9216);
  assert.equal(new Set(complete.map((item) => item.script)).size, complete.length);
  assert.throws(() => generateCases(1, maxGeneratedCount + 1), /count/);
  assert.throws(() => optionsFor(["--count", String(maxGeneratedCount + 1)]), /count/);
  for (const status of [-1, 1.5, 256, NaN, undefined])
    assert.throws(() => render({ family: "wait-pid", scope: "top", status }), /specification/);
  for (const status of [0, 2, 128, 255])
    assert.ok(render({ family: "wait-pid", scope: "top", status }).includes(`exit ${status}`));
});

test("fixed matrix covers every family, scope and status without scheduler-order output", () => {
  const cases = matrixCases();
  assert.equal(cases.length, families.length * scopes.length * statuses.length);
  assert.deepEqual(coverage(cases), {
    families: families.toSorted(),
    scopes: scopes.toSorted(),
    statuses: statuses.toSorted(),
  });
  for (const family of families)
    for (const scope of scopes)
      for (const status of statuses)
        assert.equal(
          cases.filter(
            (item) => item.family === family && item.scope === scope && item.status === status,
          ).length,
          1,
        );
  for (const item of cases.filter((item) =>
    ["jobs-one-shot", "kill-completed"].includes(item.family),
  )) {
    assert.ok(item.script.includes('while kill -0 "$jl_pid" 2>/dev/null; do :; done'));
    assert.ok(item.script.includes("while read -r jl_line"));
    assert.ok(item.script.includes('case "$jl_line" in *Done*)'));
    assert.ok(!item.script.includes("printf '%s\\n' \"$jl_pid\""));
  }
  assert.ok(environment.scope.includes("RuntimeAbi"));
  assert.equal(environment.jobControl, "off");
});

test("own source and every imported process runner source participate in identity", () => {
  const hashes = sourceHashes();
  assert.deepEqual(Object.keys(hashes), sourceFiles);
  assert.deepEqual(sourceFiles, [
    "fuzz-shell-job-lifetime.ts",
    "fuzz-shell-control-flow.ts",
    "fuzz-shell-results.ts",
    "shell-process-group.ts",
  ]);
  for (const name of sourceFiles)
    assert.equal(
      hashes[name],
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    );
  assert.equal(fingerprint(), createHash("sha256").update(JSON.stringify(hashes)).digest("hex"));
});

test("strict byte/status comparison never grants unsupported exemptions", () => {
  assert.equal(matches(observation(), observation()), true);
  assert.equal(matches(observation({ status: 7 }), observation({ status: 7 })), true);
  assert.equal(
    matches(
      observation({ stdout: Buffer.from([0, 255]) }),
      observation({ stdout: Buffer.from([0, 255]) }),
    ),
    true,
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
  assert.equal(healthy(observation({ status: 127 })), true);
  assert.equal(healthy(observation({ status: 256 })), false);
});

test("fixture validation rejects source, oracle, environment, grammar and process mutations", () => {
  assert.deepEqual(validateFixture(path, fixtureFor(), options), matrixCases());
  for (const change of [
    (f: Fixture<Case>) => {
      f.schema = 2;
    },
    (f: Fixture<Case>) => {
      f.sourceHash = "changed";
    },
    (f: Fixture<Case>) => {
      f.sourceHashes["fuzz-shell-control-flow.ts"] = "changed";
    },
    (f: Fixture<Case>) => {
      f.sourceHashes["shell-process-group.ts"] = "changed";
    },
    (f: Fixture<Case>) => {
      f.bash = "GNU bash, version 5.2.0";
    },
    (f: Fixture<Case>) => {
      f.oraclePath = "/bin/bash";
    },
    (f: Fixture<Case>) => {
      f.environment = { ...environment, jobControl: "on" };
    },
    (f: Fixture<Case>) => {
      f.environment = { ...environment, locale: "C.UTF-8" };
    },
    (f: Fixture<Case>) => {
      f.provenance = "candidate-implied";
    },
    (f: Fixture<Case>) => {
      f.seed = 42;
    },
    (f: Fixture<Case>) => {
      f.count = 1;
    },
    (f: Fixture<Case>) => {
      f.timeoutMs = 1;
    },
    (f: Fixture<Case>) => {
      f.coverage = {};
    },
    (f: Fixture<Case>) => {
      f.cases.pop();
    },
    (f: Fixture<Case>) => {
      f.cases[0].case.script += "true\n";
    },
    (f: Fixture<Case>) => {
      f.cases[0].case.tags.push("skip");
    },
    (f: Fixture<Case>) => {
      f.cases[0].case.status = 256;
    },
    (f: Fixture<Case>) => {
      f.cases[1] = structuredClone(f.cases[0]);
    },
    (f: Fixture<Case>) => {
      f.cases[0].bash.status = null;
    },
    (f: Fixture<Case>) => {
      f.cases[0].bash.signal = "SIGKILL";
    },
    (f: Fixture<Case>) => {
      f.cases[0].bash.timedOut = true;
    },
    (f: Fixture<Case>) => {
      f.cases[0].bash.error = "ENOBUFS";
    },
    (f: Fixture<Case>) => {
      f.cases[0].bash.stdoutBase64 = "not base64";
    },
    (f: Fixture<Case>) => {
      f.cases[0].bash.stderrBase64 = Buffer.alloc(outputLimit + 1).toString("base64");
    },
  ]) {
    const fixture = fixtureFor();
    change(fixture);
    assert.throws(() => validateFixture(path, fixture, options));
  }
  assert.throws(() => validateFixture("other.json", fixtureFor(), options), /filename/);
  assert.throws(
    () => validateFixture(path, fixtureFor(), { ...options, seed: 42, explicitSeed: true }),
    /seed/,
  );
});

test("CLI retains strict bounded options and mutually exclusive modes", () => {
  assert.equal(optionsFor([]).count, defaultCount);
  assert.equal(optionsFor(["--count=3"]).count, 3);
  assert.equal(optionsFor(["--seed", "0"]).seed, 0);
  assert.equal(optionsFor(["--replay", "a", "--replay", "b"]).replays.length, 2);
  for (const args of [
    ["--count", "10001"],
    ["--count", "-1"],
    ["--count", "1.5"],
    ["--seed", "-1"],
    ["--seed", "4294967296"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "30001"],
    ["--record-oracle", "a", "--replay", "b"],
    ["--self-control", "--shell", "/usr/bin/bash"],
    ["--unknown", "x"],
  ])
    assert.throws(() => optionsFor(args));
});

for (const seed of [1, 42])
  test(`committed seed ${seed} pins source and stable wait/Done observations`, () => {
    const fixturePath = new URL(`./fixtures/shell-job-lifetime-seed-${seed}.json`, import.meta.url);
    const fixture = parseFixture(
      fixturePath.pathname,
      JSON.parse(readFileSync(fixturePath, "utf8")),
      { ...options, count: defaultCount },
    );
    validateFixture(fixturePath.pathname, fixture, { ...options, count: defaultCount });
    assert.equal(fixture.provenance, "oracle-only");
    assert.equal(new Set(fixture.cases.map((entry) => entry.case.script)).size, 240);
    assert.equal(fixture.cases.slice(matrixCases().length).length, defaultCount);
    assert.ok(new Set(fixture.cases.map((entry) => entry.case.status)).size > statuses.length);
    for (const entry of fixture.cases) {
      const item = entry.case;
      const stdout = Buffer.from(entry.bash.stdoutBase64, "base64").toString();
      if (item.family === "wait-pid") {
        assert.equal(stdout, `first=${item.status}\nstatus=${item.status}\n`);
        assert.equal(entry.bash.status, item.status);
      }
      if (item.family === "wait-job")
        assert.equal(
          stdout,
          `first=${item.status}\nagain=${item.scope === "subshell" ? 127 : item.status}\nstatus=${item.status}\n`,
        );
      if (item.family === "wait-all")
        assert.equal(stdout, "all=0\nforgotten-pid=127\nstatus=127\n");
      if (item.family === "wait-empty")
        assert.equal(stdout, `empty=0\nchild=${item.status}\nstatus=0\n`);
      if (item.family === "wait-unknown")
        assert.equal(stdout, `unknown-pid=127\nremembered=${item.status}\nstatus=127\n`);
      if (item.family === "jobs-one-shot")
        assert.equal(
          stdout,
          `jobs-first=0\nfirst=${item.status === 0 ? "Done" : "Exit"}\njobs-second=0\ngone-job=127\nstatus=${item.status}\n`,
        );
      if (item.family === "jobs-after-wait")
        assert.equal(
          stdout,
          `wait=${item.status}\njobs-consumed=0\ngone-job=127\nstatus=${item.status}\n`,
        );
      if (item.family === "kill-completed")
        assert.equal(
          stdout,
          `numeric-zero=1\nnumeric-kill=1\npercent-kill=0\njobs-done=0\ndone=${item.status === 0 ? "Done" : "Exit"}\ngone-kill=1\nstatus=${item.status}\n`,
        );
    }
  });
