import assert from "node:assert/strict";
import { compareScores, digest, summarize, validateScore } from "./shell-scoreboard.ts";

export const bootstrap = Object.freeze({
  sourceSha: "9fc1cdbd907ab376e61039331b43b379addea754",
  runId: 40105927170,
  attempt: 1,
  jobId: 120908810986,
  observationStep: 14,
  uploadStep: 15,
  artifactId: 12564749101,
  archiveSha256: "2e862e49ee3ed1e2405c4659c9096b0b0227404c6a45f8677619bf36e7b85e21",
  scoreSha256: "25f2e910986a9e56adaef17ca453823b3b8de2d8b1510db513ca30902354d49a",
});

export function validateOwnScore(oracle, score) {
  assert.equal(score.engine, "own-shell", "unexpected score engine");
  validateScore(oracle, score);
}
function scoreFloor(oracle, score) {
  validateOwnScore(oracle, score);
  return score.cases
    .filter((item) => item.outcome === "pass")
    .map((item) => item.id)
    .sort();
}
export function validateFloor(oracle, floor) {
  assert.equal(floor.schema, 1, "unsupported floor schema");
  assert.equal(floor.kind, "main-floor");
  assert.match(floor.sourceSha, /^[a-f0-9]{40}$/, "invalid floor source SHA");
  assert.deepEqual(floor.identity, oracle.identity, "floor identity changed");
  assert.ok(Array.isArray(floor.floorIds), "missing floor IDs");
  assert.deepEqual(
    floor.floorIds,
    Array.from(new Set(floor.floorIds)).sort(),
    "floor IDs must be sorted and unique",
  );
  const scored = new Set(
    oracle.cases
      .filter((item) => !item.excluded && item.kind === "builtins-only")
      .map((item) => item.id),
  );
  for (const id of floor.floorIds)
    assert.ok(scored.has(id), `unknown or excluded floor case ${id}`);
  assert.equal(floor.floorSha256, digest(floor.floorIds), "floor membership digest");
  return floor;
}
export function compareFloor(oracle, floor, score) {
  validateFloor(oracle, floor);
  validateOwnScore(oracle, score);
  const required = new Set(floor.floorIds);
  const cases = score.cases.map((item) => ({
    ...item,
    outcome: item.outcome === "skip" ? "skip" : required.has(item.id) ? "pass" : "fail",
  }));
  return compareScores({ identity: oracle.identity, engine: "own-shell", cases }, score);
}
export function accumulateFloor({ oracle, sourceSha, predecessors, scores, evidence = [] }) {
  assert.ok(predecessors.length > 0, "missing predecessor floor");
  const ids = new Set();
  for (const predecessor of predecessors) {
    validateFloor(oracle, predecessor);
    for (const id of predecessor.floorIds) ids.add(id);
  }
  for (const score of scores) for (const id of scoreFloor(oracle, score)) ids.add(id);
  const floorIds = Array.from(ids).sort();
  return validateFloor(oracle, {
    schema: 1,
    kind: "main-floor",
    sourceSha,
    identity: oracle.identity,
    floorSha256: digest(floorIds),
    floorIds,
    evidence,
  });
}
export function bootstrapFloor(oracle, sourceSha, score) {
  assert.equal(sourceSha, bootstrap.sourceSha, "bootstrap is authorized only at its exact cut");
  validateOwnScore(oracle, score);
  assert.equal(digest(score), bootstrap.scoreSha256, "bootstrap content digest");
  const floorIds = scoreFloor(oracle, score);
  return {
    schema: 1,
    kind: "main-floor",
    sourceSha,
    identity: oracle.identity,
    floorIds,
    floorSha256: digest(floorIds),
    evidence: [{ kind: "bootstrap", ...bootstrap }],
  };
}
export function qualification(oracle, floor, score, binding) {
  const delta = compareFloor(oracle, floor, score);
  return {
    schema: 1,
    kind: "qualification",
    binding,
    floorSha256: floor.floorSha256,
    scoreSha256: digest(score),
    counts: summarize(score),
    ...delta,
  };
}
