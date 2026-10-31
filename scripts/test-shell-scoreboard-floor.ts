import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateFloor,
  bootstrap,
  bootstrapFloor,
  compareFloor,
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
