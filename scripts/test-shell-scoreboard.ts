import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertOracle,
  assertRecord,
  assertScore,
  sealOracle,
  identityFor,
  summarize,
  compareScores,
  verifyOracle,
} from "./shell-scoreboard.ts";
import type { ComparableScore, Oracle } from "./shell-scoreboard.ts";

function fixture(): Oracle {
  return sealOracle({
    schema: 1,
    oracle: { version: "GNU bash 5.3.15", sha256: "oracle-binary" },
    environment: { locale: "C.UTF-8", stdin: "empty" },
    sources: { oils: "pinned", "brush-suite": "pinned", "bashkit-suite": "pinned" },
    cases: ["oils", "brush-suite", "bashkit-suite"].map((corpus) => ({
      id: `${corpus}:example:1`,
      corpus,
      category: "example",
      code: "printf '\\377'",
      kind: "builtins-only",
      bash: { status: 0, stdout: "/w==", stderr: "" },
    })),
  });
}
function score(oracle: Oracle, outcomes: string[] = ["pass", "pass", "pass"]): ComparableScore {
  return {
    identity: identityFor(oracle),
    cases: oracle.cases.map((item, index) => ({
      id: item.id,
      corpus: item.corpus,
      category: item.category,
      outcome: outcomes[index],
    })),
  };
}

test("exact per-corpus counts reject a single lost pass", () => {
  const oracle = fixture();
  const base = score(oracle);
  const next = score(oracle, ["fail", "pass", "pass"]);
  const delta = compareScores(base, next);
  assert.equal(delta.ok, false);
  assert.deepEqual(delta.corpora.oils.lost, ["oils:example:1"]);
  assert.equal(summarize(next).oils.passed, 0);
});

test("gains cannot conceal a regression in another corpus", () => {
  const oracle = fixture();
  const delta = compareScores(
    score(oracle, ["pass", "fail", "pass"]),
    score(oracle, ["fail", "pass", "pass"]),
  );
  assert.equal(delta.ok, false);
  assert.deepEqual(delta.corpora["brush-suite"].gained, ["brush-suite:example:1"]);
});

test("same-corpus gains cannot conceal lost passes with equal or growing counts", () => {
  const oracle = fixture();
  oracle.cases = oracle.cases.map((item, index) => ({
    ...item,
    id: `oils:example:${index + 1}`,
    corpus: "oils",
  }));
  const sealed = sealOracle(oracle);
  const before = score(sealed, ["pass", "fail", "fail"]);
  for (const outcomes of [
    ["fail", "pass", "fail"],
    ["fail", "pass", "pass"],
  ]) {
    const delta = compareScores(before, score(sealed, outcomes));
    assert.equal(delta.ok, false);
    assert.deepEqual(delta.corpora.oils.lost, ["oils:example:1"]);
    assert.equal(delta.corpora.oils.before, 1);
    assert.ok(delta.corpora.oils.after >= delta.corpora.oils.before);
  }
});

test("identity changes and incomplete/duplicate results are rejected", () => {
  for (const key of ["caseSet", "oracle", "environment", "sources"]) {
    const oracle = fixture();
    const next = score(oracle);
    assertRecord(next.identity);
    next.identity[key] = "changed";
    assert.throws(() => compareScores(score(oracle), next), /incomparable/);
  }
  const oracle = fixture();
  const next = score(oracle);
  next.cases.pop();
  assert.throws(() => compareScores(score(oracle), next), /case/);
  next.cases.push(next.cases[0]);
  assert.throws(() => compareScores(score(oracle), next), /case/);
});

test("oracle bytes, code, skips and source pins participate in identity", () => {
  const changes: ((oracle: Oracle) => void)[] = [
    (oracle) => {
      oracle.cases[0].code = "false";
    },
    (oracle) => {
      const bash = oracle.cases[0].bash;
      assert.ok(bash);
      bash.stdout = "AA==";
    },
    (oracle) => {
      oracle.cases[0].excluded = "new skip";
    },
    (oracle) => {
      oracle.sources.oils = "changed";
    },
  ];
  for (const change of changes) {
    const oracle = fixture();
    change(oracle);
    assert.throws(() => verifyOracle(oracle), /identity/);
  }
});

test("category counts and unchanged skips are explicit", () => {
  const oracle = fixture();
  oracle.cases.push({
    id: "oils:skip:2",
    corpus: "oils",
    category: "example",
    code: "",
    excluded: "fixture required",
  });
  const sealed = sealOracle(oracle);
  const actual = score(sealed);
  actual.cases[3].outcome = "skip";
  const summary = summarize(actual);
  assert.deepEqual(summary.oils.categories.example, { total: 2, passed: 1, skipped: 1 });
  assert.equal(compareScores(actual, actual).ok, true);
});

test("corpus notices retain the pinned revisions and license bytes", async () => {
  const { readFile } = await import("node:fs/promises");
  const { bytesDigest } = await import("./shell-scoreboard.ts");
  const pins: unknown = JSON.parse(
    await readFile(new URL("../sources.lock.json", import.meta.url), "utf8"),
  );
  assertRecord(pins);
  assertRecord(pins.shellScoreboard);
  assertRecord(pins.shellScoreboard.corpora);
  const revisions: Record<string, string> = {};
  for (const [corpus, key] of [
    ["oils", "oils"],
    ["brush-suite", "brush"],
    ["bashkit-suite", "bashkitTerminal"],
  ]) {
    const pin: unknown = pins[key];
    assertRecord(pin);
    assert.ok(typeof pin.revision === "string");
    revisions[corpus] = pin.revision;
  }
  for (const [corpus, value] of Object.entries(pins.shellScoreboard.corpora)) {
    assertRecord(value);
    assert.equal(value.revision, revisions[corpus]);
    assert.equal(typeof value.licenseFile, "string");
    assert.equal(typeof value.licenseSha256, "string");
    const bytes = await readFile(new URL(`../${value.licenseFile}`, import.meta.url));
    assert.equal(bytesDigest(bytes), value.licenseSha256);
  }
});

test("a gained pass requires updating the candidate baseline", () => {
  const oracle = fixture();
  const before = score(oracle, ["fail", "pass", "pass"]);
  const after = score(oracle);
  assert.equal(compareScores(before, after).ok, true);
  assert.throws(
    () => compareScores(before, after, { requireMembership: true }),
    /stale candidate baseline/,
  );
  const stillFailing = score(oracle, ["timeout", "pass", "pass"]);
  assert.doesNotThrow(() => compareScores(before, stillFailing, { requireMembership: true }));
});

test("score diagnostics bound prefixes while retaining long stream identity", async () => {
  const { compactResult, bytesDigest } = await import("./shell-scoreboard.ts");
  const stdout = Buffer.alloc(4096, 255);
  const diagnostic = compactResult({ status: 7, stdout, stderr: Buffer.from([0, 255]) });
  assert.equal(diagnostic.status, 7);
  assert.ok(typeof diagnostic.stdout !== "string");
  assert.equal(Buffer.from(diagnostic.stdout.base64, "base64").length, 240);
  assert.equal(diagnostic.stdout.bytes, stdout.length);
  assert.equal(diagnostic.stdout.sha256, bytesDigest(stdout));
  assert.equal(diagnostic.stderr, "AP8=");
});

test("committed oracle and baseline preserve exact identities, skips and counts", async () => {
  const { readFile } = await import("node:fs/promises");
  const { bytesDigest, validateScore } = await import("./shell-scoreboard.ts");
  const pins: unknown = JSON.parse(
    await readFile(new URL("../sources.lock.json", import.meta.url), "utf8"),
  );
  assertRecord(pins);
  assertRecord(pins.shellScoreboard);
  assert.equal(typeof pins.shellScoreboard.oracleFile, "string");
  assert.equal(typeof pins.shellScoreboard.baselineFile, "string");
  const bytes = await readFile(new URL(`../${pins.shellScoreboard.oracleFile}`, import.meta.url));
  assert.equal(bytesDigest(bytes), pins.shellScoreboard.oracleSha256);
  const oracle: unknown = JSON.parse(bytes.toString("utf8"));
  const baseline: unknown = JSON.parse(
    await readFile(new URL(`../${pins.shellScoreboard.baselineFile}`, import.meta.url), "utf8"),
  );
  assertOracle(oracle);
  assertScore(baseline);
  verifyOracle(oracle);
  validateScore(oracle, baseline);
  compareScores(baseline, baseline, { requireMembership: true });
  assert.equal(oracle.environment.nodeVersion, "v26.12.1");
});
