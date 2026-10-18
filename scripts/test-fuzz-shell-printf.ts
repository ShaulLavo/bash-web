import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import test from "node:test";
import {
  boundaryEscapes,
  coverage,
  defaultCount,
  defaultTimeoutMs,
  environment,
  fingerprint,
  generateCases,
  generatedModes,
  generatedSuffixes,
  healthy,
  matches,
  matrixCases,
  maxGeneratedCount,
  modes,
  optionsFor,
  originalEscapes,
  originalSequences,
  outputLimit,
  render,
  run,
  sequenceBodies,
  sourceFiles,
  sourceHashes,
  validateFixture,
} from "./fuzz-shell-printf.ts";

const options = { seed: 1, count: 0, timeoutMs: defaultTimeoutMs };
const path = "shell-printf-seed-1.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const observation = (patch = {}) => ({
  status: 0,
  signal: null,
  timedOut: false,
  error: null,
  stdout: Buffer.from([0, 255, 254, 128]),
  stderr: Buffer.alloc(0),
  ...patch,
});
function fixtureFor() {
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

test("deterministic finite grammar has distinct substantive seeded cases", () => {
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed);
    assert.deepEqual(cases, generateCases(seed));
    assert.equal(cases.length, 561);
    assert.equal(cases.length, matrixCases().length + defaultCount);
    assert.deepEqual(cases.slice(0, matrixCases().length), matrixCases());
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.equal(new Set(cases.map((item) => item.script)).size, cases.length);
    for (const item of cases) {
      assert.equal(item.script, render(item));
      assert.ok(item.script.length < 400);
      assert.ok(!/\b(?:declare|local|sleep|bash|cat|timeout)\b|\$\(|`/.test(item.script));
      assert.ok(!Object.hasOwn(item, "skip"));
      assert.ok(!Object.hasOwn(item, "unsupported"));
    }
    const generated = cases.slice(matrixCases().length);
    assert.deepEqual(
      Array.from(new Set(generated.map((item) => item.mode))).sort(),
      generatedModes.toSorted(),
    );
    assert.ok(new Set(generated.map((item) => item.value)).size > 80);
    assert.ok(
      generated.every((item) => item.script.includes(item.value + generatedSuffixes[item.variant])),
    );
  }
  assert.notDeepEqual(generateCases(1, 20), generateCases(42, 20));
  const first = new Set(
    generateCases(1)
      .slice(matrixCases().length)
      .map((item) => item.script),
  );
  assert.ok(
    generateCases(42)
      .slice(matrixCases().length)
      .filter((item) => first.has(item.script)).length < 12,
  );
  assert.equal(maxGeneratedCount, 8192);
  const complete = generateCases(1, maxGeneratedCount);
  assert.equal(complete.length, 8625);
  assert.equal(new Set(complete.map((item) => item.script)).size, complete.length);
  for (const seed of [-1, 0x100000000, 1.5, NaN]) assert.throws(() => generateCases(seed), /seed/);
  for (const count of [-1, 8193, 1.5, NaN]) assert.throws(() => generateCases(1, count), /count/);
  assert.throws(
    () => render({ family: "unknown", mode: "format", value: "", variant: 0 }),
    /specification/,
  );
});

test("fixed matrix preserves the original 107 scripts and full escape boundaries", () => {
  const cases = matrixCases();
  assert.equal(originalEscapes.length, 51);
  assert.equal(originalSequences.length, 5);
  assert.equal(boundaryEscapes.length, 114);
  assert.equal(sequenceBodies.length, 24);
  assert.equal(cases.length, 433);
  // Captured independently from the original investigation, not candidate output.
  assert.equal(
    hash(JSON.stringify(cases.slice(0, 107).map((item) => item.script))),
    "7c9a9e3993b0e0ab752dadf3fef6b08e2ab0d3ade77dcd472f600adbe506d43f",
  );
  assert.deepEqual(modes, ["format", "percent-b"]);
  assert.ok(environment.comparison.includes("raw stdout bytes"));
  assert.ok(environment.locale.startsWith("C;"));
  for (const escape of [
    "\\0",
    "\\377",
    "\\400",
    "\\777",
    "\\0123",
    "\\x",
    "\\xg1",
    "\\u",
    "\\ud800",
    "\\U00110000",
    "\\U7fffffff",
    "\\U80000000",
    "\\Uffffffff",
    "\\c",
    "\\e",
    "\\E",
  ]) {
    for (const mode of modes)
      assert.ok(cases.some((item) => item.mode === mode && item.value === escape));
  }
  for (const mode of modes)
    assert.ok(
      cases.some((item) => item.family === "trailing" && item.mode === mode && item.value === "\\"),
    );
  assert.ok(sequenceBodies.some((body) => body.includes("shell-continued")));
});

test("every transitive raw runner source participates in fixture identity", () => {
  const hashes = sourceHashes();
  assert.deepEqual(sourceFiles, [
    "fuzz-shell-printf.ts",
    "fuzz-shell-control-flow.mjs",
    "shell-process-group.mjs",
  ]);
  assert.deepEqual(Object.keys(hashes), sourceFiles);
  for (const name of sourceFiles)
    assert.equal(hashes[name], hash(readFileSync(new URL(name, import.meta.url))));
  assert.equal(fingerprint(), hash(JSON.stringify(hashes)));
});

test("comparison is byte-exact, healthy and strict without stderr normalization", () => {
  assert.equal(matches(observation(), observation()), true);
  // FF and FE would both become U+FFFD if either side were UTF-8 decoded first.
  assert.equal(Buffer.from([255]).toString("utf8"), Buffer.from([254]).toString("utf8"));
  assert.equal(
    matches(
      observation({ stdout: Buffer.from([255]) }),
      observation({ stdout: Buffer.from([254]) }),
    ),
    false,
  );
  assert.equal(
    matches(
      observation({ stdout: Buffer.from([0, 255]) }),
      observation({ stdout: Buffer.from([0, 255]) }),
    ),
    true,
  );
  for (const patch of [
    { stdout: Buffer.from([255]) },
    { status: 1 },
    { signal: "SIGKILL" },
    { timedOut: true },
    { error: "ENOBUFS" },
    { error: "ETIMEDOUT" },
    { status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("unsupported") },
  ])
    assert.equal(matches(observation(), observation(patch)), false);
  assert.equal(matches(observation(), observation({ stderr: Buffer.from([255, 0]) })), true);
  for (const status of [0, 1, 127, 255]) assert.equal(healthy(observation({ status })), true);
  for (const status of [-1, 256, null, 1.5]) assert.equal(healthy(observation({ status })), false);
});

test("fixture validation rejects identity, grammar, encoding and process mutations", () => {
  assert.deepEqual(validateFixture(path, fixtureFor(), options), matrixCases());
  for (const change of [
    (f) => {
      f.schema = 2;
    },
    (f) => {
      f.sourceHash = "changed";
    },
    (f) => {
      f.sourceHashes["fuzz-shell-control-flow.mjs"] = "changed";
    },
    (f) => {
      f.sourceHashes["shell-process-group.mjs"] = "changed";
    },
    (f) => {
      f.bash = "GNU bash, version 5.2.0";
    },
    (f) => {
      f.oraclePath = "/bin/sh";
    },
    (f) => {
      f.environment = { ...environment, locale: "C.UTF-8" };
    },
    (f) => {
      f.provenance = "unknown";
    },
    (f) => {
      f.seed = 42;
    },
    (f) => {
      f.seed = -1;
    },
    (f) => {
      f.count = 1;
    },
    (f) => {
      f.timeoutMs++;
    },
    (f) => {
      f.coverage = {};
    },
    (f) => {
      f.cases.pop();
    },
    (f) => {
      f.cases[0].case.script += "\n";
    },
    (f) => {
      f.cases[0].case.value = "\\xFF";
    },
    (f) => {
      f.cases[0].case.skip = true;
    },
    (f) => {
      f.cases[0].bash.status = 256;
    },
    (f) => {
      f.cases[0].bash.signal = "SIGTERM";
    },
    (f) => {
      f.cases[0].bash.timedOut = true;
    },
    (f) => {
      f.cases[0].bash.error = "EIO";
    },
    (f) => {
      f.cases[0].bash.stdoutBase64 = "!";
    },
    (f) => {
      f.cases[0].bash.stderrBase64 = "YQ";
    },
    (f) => {
      f.cases[0].bash.stdoutBase64 = Buffer.alloc(outputLimit + 1).toString("base64");
    },
    (f) => {
      f.cases[0].bash.stdoutBase64 = Buffer.alloc(outputLimit).toString("base64");
      f.cases[0].bash.stderrBase64 = "AA==";
    },
  ]) {
    const fixture = fixtureFor();
    change(fixture);
    assert.throws(() => validateFixture(path, fixture, options));
  }
  assert.throws(() => validateFixture("shell-printf-seed-42.json", fixtureFor(), options), /seed/);
  assert.throws(
    () => validateFixture(path, fixtureFor(), { ...options, explicitSeed: true, seed: 42 }),
    /seed/,
  );
  const raw = fixtureFor();
  raw.cases[0].bash.stdoutBase64 = "AP/+gA==";
  assert.deepEqual(validateFixture(path, raw, options), matrixCases());
});

test("CLI bounds and modes cannot weaken replay", () => {
  assert.equal(optionsFor([]).count, 128);
  assert.deepEqual(
    optionsFor(["--replay", "a", "--replay", "b"]).replays.map((value) => value.slice(-1)),
    ["a", "b"],
  );
  for (const args of [
    ["--count", "8193"],
    ["--seed", "-1"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "30001"],
    ["--record", "a", "--replay", "b"],
    ["--record-oracle", "a", "--self-control"],
    ["--self-control", "--shell", "/usr/bin/bash"],
    ["--unit-only"],
    ["--unknown", "value"],
  ])
    assert.throws(() => optionsFor(args));
});

test("raw process transport preserves NUL/invalid UTF8 and drains timeout/output descendants", async () => {
  const parent =
    process.env.FUZZ_PRINTF_SCRATCH ?? "/work/tmp/bash-web-printf-20261018/oracle-worker";
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(parent + "/source-test-");
  const owned = { cwd, timeoutMs: 2000, interrupted: false };
  const onSignal = () => {
    owned.interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const raw = await run(
      "/usr/bin/bash",
      "printf '\\000\\377\\376\\200'; printf '\\377\\000' >&2",
      owned,
    );
    assert.ok(healthy(raw));
    assert.deepEqual(raw.stdout, Buffer.from([0, 255, 254, 128]));
    assert.deepEqual(raw.stderr, Buffer.from([255, 0]));
    assert.deepEqual(readdirSync(cwd), []);
    const timeout = await run("/usr/bin/bash", "(while :; do :; done) & wait", {
      ...owned,
      timeoutMs: 60,
    });
    assert.equal(timeout.timedOut, true);
    assert.equal(healthy(timeout), false);
    assert.deepEqual(readdirSync(cwd), []);
    const cap = await run(
      "/usr/bin/bash",
      "while :; do printf '0123456789012345678901234567890123456789012345678901234567890123456789'; done",
      owned,
    );
    assert.equal(cap.error, "ENOBUFS");
    assert.equal(healthy(cap), false);
    assert.ok(cap.stdout.length + cap.stderr.length <= outputLimit);
    assert.deepEqual(readdirSync(cwd), []);
    const missing = await run(cwd + "/no-such-shell", ":", owned);
    assert.equal(missing.error, "ENOENT");
    assert.equal(healthy(missing), false);
    assert.deepEqual(readdirSync(cwd), []);
    const recovery = await run("/usr/bin/bash", "printf recovered", owned);
    assert.ok(healthy(recovery));
    assert.equal(recovery.stdout.toString("ascii"), "recovered");
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    // All calls above await owned process-group teardown before sandbox removal.
    if (readdirSync(cwd).length === 0) rmSync(cwd, { recursive: true });
  }
});

for (const seed of [1, 42])
  test("frozen seed " + seed + " preserves independently recorded raw Bash bytes", () => {
    const url = new URL(`./fixtures/shell-printf-seed-${seed}.json`, import.meta.url);
    const bytes = readFileSync(url);
    assert.equal(
      hash(bytes),
      seed === 1
        ? "0136185350097ef5e41c1fe8e368886c75643e8e0b8a3dbe1b6afb0deb797667"
        : "6c1f0ea1b0b5c2b6dc1df3fbdf9764b99113cc30ddaaa3139fb1e17604246409",
    );
    const fixture = JSON.parse(bytes.toString("utf8"));
    const cases = validateFixture(url.pathname, fixture, {
      seed,
      count: defaultCount,
      timeoutMs: defaultTimeoutMs,
    });
    assert.equal(cases.length, 561);
    assert.equal(fixture.provenance, "oracle-only");
    for (const [index, entry] of fixture.cases.entries()) {
      const stdout = Buffer.from(entry.bash.stdoutBase64, "base64");
      assert.ok(healthy(entry.bash));
      assert.ok(stdout.length <= outputLimit);
      if (index === 0) assert.deepEqual(stdout, Buffer.from("A\x07Z|after:0|"));
    }
    const find = (mode: string, value: string) =>
      fixture.cases.find(
        (entry) =>
          entry.case.family === "escape" && entry.case.mode === mode && entry.case.value === value,
      ).bash;
    for (const mode of modes) {
      assert.deepEqual(
        Buffer.from(find(mode, "\\377").stdoutBase64, "base64"),
        Buffer.from([65, 255, 90].concat(Array.from(Buffer.from("|after:0|")))),
      );
      assert.deepEqual(
        Buffer.from(find(mode, "\\x00").stdoutBase64, "base64"),
        Buffer.from([65, 0, 90].concat(Array.from(Buffer.from("|after:0|")))),
      );
      assert.equal(
        Buffer.from(find(mode, "\\ud800").stdoutBase64, "base64").toString("ascii"),
        "A\\uD800Z|after:0|",
      );
      assert.equal(
        Buffer.from(find(mode, "\\U80000000").stdoutBase64, "base64").toString("ascii"),
        "AZ|after:0|",
      );
      assert.equal(
        Buffer.from(find(mode, "\\x").stderrBase64, "base64")
          .toString("ascii")
          .includes("missing hex digit"),
        true,
      );
    }
  });
