import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateFloor,
  bootstrap,
  bootstrapFloor,
  compareFloor,
  correctFalsePasses,
  falsePassCorrections,
  qualification,
  validateFloor,
} from "./shell-scoreboard-floor.ts";
import { digest, summarize, validateScore } from "./shell-scoreboard.ts";

import { scoreboardFixture } from "./shell-scoreboard-test-fixture.ts";

const { oracle, score, floor } = scoreboardFixture("brush-suite");
test("gains succeed, replacements and lost current-main gains fail", () => {
  assert.equal(compareFloor(oracle, floor(["a"]), score(["a", "x"])).ok, true);
  assert.equal(compareFloor(oracle, floor(["a"]), score(["x"])).ok, false);
  const main = accumulateFloor({
    oracle,
    sourceSha: "b".repeat(40),
    predecessors: [floor(["a"])],
    scores: [score(["a", "x"])],
  });
  assert.equal(compareFloor(oracle, main, score(["a"])).ok, false);
});
test("all same-SHA attempts union; a regression cannot lower the floor", () => {
  const result = accumulateFloor({
    oracle,
    sourceSha: "b".repeat(40),
    predecessors: [floor(["a"])],
    scores: [score(["a", "x"]), score(["a", "y"]), score(["y"])],
  });
  assert.equal(validateFloor(oracle, result), result);
  assert.deepEqual(result.floorIds, ["a", "x", "y"]);
  assert.equal(compareFloor(oracle, result, score(["a", "y"])).ok, false);
});
test("the known complete failed timeout is valid, but a required pass becoming timeout fails", () => {
  const observed = score(["a"], true);
  validateScore(oracle, observed);
  assert.equal(compareFloor(oracle, floor(["a"]), observed).ok, true);
  assert.equal(
    compareFloor(oracle, floor(["a", "brush-suite:compound_cmds/until:8"]), observed).ok,
    false,
  );
});
test("unknown outcomes, duplicates, incomplete scores and malformed membership fail closed", () => {
  const bad = score(["a"]);
  bad.cases[0].outcome = "incomplete";
  assert.throws(() => validateScore(oracle, bad), /invalid case outcome/);
  const duplicate = score(["a"]);
  duplicate.cases[1] = duplicate.cases[0];
  duplicate.counts = summarize(duplicate);
  assert.throws(() => validateScore(oracle, duplicate), /duplicate result case/);
  const partial = score(["a"]);
  partial.cases.pop();
  partial.counts = summarize(partial);
  assert.throws(() => validateScore(oracle, partial), /result case count changed/);
  assert.throws(() => validateFloor(oracle, floor(["a", "a"])));
  assert.throws(() => validateFloor(oracle, floor(["unknown"])));
  assert.throws(
    () => accumulateFloor({ oracle, sourceSha: "a".repeat(40), predecessors: [], scores: [] }),
    /predecessor/,
  );
});
test("accumulation rejects missing or malformed source SHAs", () => {
  for (const sourceSha of [undefined, "bad", 42])
    assert.throws(
      () =>
        accumulateFloor({
          oracle,
          sourceSha,
          predecessors: [floor(["a"])],
          scores: [score(["a", "x"])],
        }),
      /invalid floor source SHA/,
    );
});
test("bootstrap cannot authorize a later or weaker source", () => {
  assert.throws(() => bootstrapFloor(oracle, "a".repeat(40), score(["a"])), /exact cut/);
  assert.throws(() => bootstrapFloor(oracle, bootstrap.sourceSha, score(["a"])), /content digest/);
});
test("canonical hashing sorts keys and preserves UTF-8 rather than ASCII escaping", () => {
  assert.equal(digest({ z: "🦀", a: "é" }), digest({ a: "é", z: "🦀" }));
  assert.equal(
    digest({ a: "é", z: "🦀" }),
    "e44dd0cd085bfa16675c23522ae29b1b5db6a3ad0175b249c233b3163c51c9ff",
  );
});

const correctedIds = [
  "oils:builtin-read:605",
  "oils:builtin-read:619",
  "brush-suite:builtins/mapfile:10",
];
const correctedFixture = scoreboardFixture("brush-suite", ["real", "new"].concat(correctedIds));

test("only the three approved false passes are removed, with durable reasons", () => {
  const { oracle, floor, score } = correctedFixture;
  const original = floor(["real"].concat(correctedIds));
  assert.equal(compareFloor(oracle, original, score(["real"])).ok, false);
  const corrected = correctFalsePasses(oracle, original);
  assert.deepEqual(corrected.floorIds, ["real"]);
  assert.deepEqual(corrected.corrections, falsePassCorrections);
  assert.deepEqual(original.floorIds, ["real"].concat(correctedIds).sort());
  assert.equal(compareFloor(oracle, corrected, score(["real"])).ok, true);
  assert.equal(compareFloor(oracle, corrected, score([])).ok, false);
  for (const { reason } of corrected.corrections ?? []) {
    assert.match(reason, /^false pass: earlier redirection failure masked unsupported /);
    assert.match(reason, /real support tracked in plans\/007-agent-shell-compatibility.md#/);
  }
  const receipt = qualification(oracle, corrected, score(["real"]), {
    kind: "main-push",
    sourceSha: "b".repeat(40),
    beforeSha: "a".repeat(40),
  });
  assert.deepEqual(receipt.floorCorrections, falsePassCorrections);
});

test("a corrected case can be re-earned and then cannot be lost", () => {
  const { oracle, floor, score } = correctedFixture;
  const historical = floor(["real"].concat(correctedIds));
  const corrected = correctFalsePasses(oracle, historical);
  const earned = accumulateFloor({
    oracle,
    sourceSha: "b".repeat(40),
    predecessors: [corrected, historical],
    scores: [score(["real", correctedIds[0]])],
  });
  assert.deepEqual(earned.floorIds, ["real", correctedIds[0]].sort());
  assert.deepEqual(earned.corrections, falsePassCorrections);
  assert.equal(correctFalsePasses(oracle, earned), earned);
  assert.equal(compareFloor(oracle, earned, score(["real"])).ok, false);
});

test("unknown, duplicate or changed correction reasons are rejected", () => {
  const { oracle, floor } = correctedFixture;
  const corrected = correctFalsePasses(oracle, floor(correctedIds));
  assert.throws(
    () =>
      validateFloor(oracle, {
        ...corrected,
        corrections: [{ id: "real", reason: "not an approved correction" }],
      }),
    /approved/,
  );
  assert.throws(
    () =>
      validateFloor(oracle, {
        ...corrected,
        corrections: falsePassCorrections.concat([falsePassCorrections[0]]),
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateFloor(oracle, {
        ...corrected,
        corrections: [{ ...falsePassCorrections[0], reason: "" }],
      }),
    /approved/,
  );
});
