import assert from "node:assert/strict";
import {
  assertBinding,
  assertIdentity,
  assertRecord,
  compareScores,
  digest,
  summarize,
  validateScore,
} from "./shell-scoreboard.ts";
import type { Binding, Oracle, RunBinding, Score, ScoreComparison } from "./shell-scoreboard.ts";

export interface FloorEvidence {
  kind: string;
  [key: string]: unknown;
}
export interface MainFloor {
  schema: number;
  kind: "main-floor";
  sourceSha: string;
  identity: Oracle["identity"];
  floorSha256: string;
  floorIds: string[];
  evidence: FloorEvidence[];
  run?: RunBinding;
  beforeSha?: string;
  lostIds?: string[];
  [key: string]: unknown;
}
export function assertMainFloor(value: unknown): asserts value is MainFloor {
  assertRecord(value);
  assert.equal(value.kind, "main-floor", "unsupported floor kind");
  assert.equal(typeof value.schema, "number", "missing floor schema");
  assert.equal(typeof value.sourceSha, "string", "missing floor source SHA");
  assertIdentity(value.identity);
  assert.equal(typeof value.floorSha256, "string", "missing floor digest");
  assert.ok(Array.isArray(value.floorIds), "missing floor IDs");
  for (const id of value.floorIds) assert.equal(typeof id, "string", "invalid floor ID");
  assert.ok(Array.isArray(value.evidence), "missing floor evidence");
  for (const evidence of value.evidence) {
    assertRecord(evidence);
    assert.equal(typeof evidence.kind, "string", "invalid floor evidence");
  }
}
function assertCountFields(value: Record<string, unknown>, label: string): void {
  for (const key of ["total", "passed", "skipped"])
    assert.equal(typeof value[key], "number", `missing ${label} ${key}`);
}
function assertSummaryCategories(summary: Record<string, unknown>): void {
  assertRecord(summary.categories);
  for (const category of Object.values(summary.categories)) {
    assertRecord(category);
    assertCountFields(category, "category");
  }
}
export function assertQualification(value: unknown): asserts value is Qualification {
  assertRecord(value);
  assert.equal(value.kind, "qualification", "unsupported qualification kind");
  assert.equal(typeof value.schema, "number", "missing qualification schema");
  assertBinding(value.binding);
  assert.equal(typeof value.floorSha256, "string", "missing qualification floor digest");
  assert.equal(typeof value.scoreSha256, "string", "missing qualification score digest");
  assert.equal(typeof value.ok, "boolean", "missing qualification result");
  assertRecord(value.counts);
  for (const summary of Object.values(value.counts)) {
    assertRecord(summary);
    assertCountFields(summary, "summary");
    assertSummaryCategories(summary);
  }
  assertRecord(value.corpora);
  for (const corpus of Object.values(value.corpora)) {
    assertRecord(corpus);
    assert.equal(typeof corpus.before, "number", "missing comparison before count");
    assert.equal(typeof corpus.after, "number", "missing comparison after count");
    assert.ok(Array.isArray(corpus.gained), "missing gained IDs");
    assert.ok(Array.isArray(corpus.lost), "missing lost IDs");
    assert.ok(Array.isArray(corpus.newlyFailing), "missing newly failing IDs");
  }
}
export interface Qualification extends ScoreComparison {
  schema: number;
  kind: "qualification";
  binding: Binding;
  floorSha256: string;
  scoreSha256: string;
  counts: ReturnType<typeof summarize>;
  observedMainAfter?: string | null;
  gainedSincePredecessor?: Record<string, string[]>;
  floorSource?: unknown;
  [key: string]: unknown;
}

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

export function validateOwnScore(oracle: Oracle, score: Score): void {
  assert.equal(score.engine, "own-shell", "unexpected score engine");
  validateScore(oracle, score);
}
function scoreFloor(oracle: Oracle, score: Score): string[] {
  validateOwnScore(oracle, score);
  return score.cases
    .filter((item) => item.outcome === "pass")
    .map((item) => item.id)
    .sort();
}
export function validateFloor(oracle: Oracle, floor: MainFloor): MainFloor {
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
export function compareFloor(oracle: Oracle, floor: MainFloor, score: Score): ScoreComparison {
  validateFloor(oracle, floor);
  validateOwnScore(oracle, score);
  const required = new Set(floor.floorIds);
  const cases = score.cases.map((item) => ({
    ...item,
    outcome: item.outcome === "skip" ? "skip" : required.has(item.id) ? "pass" : "fail",
  }));
  return compareScores({ identity: oracle.identity, engine: "own-shell", cases }, score);
}
function validSourceSha(value: unknown): string {
  assert.ok(typeof value === "string", "invalid floor source SHA");
  assert.match(value, /^[a-f0-9]{40}$/, "invalid floor source SHA");
  return value;
}
export function accumulateFloor({
  oracle,
  sourceSha,
  predecessors,
  scores,
  evidence = [],
}: {
  oracle: Oracle;
  sourceSha: unknown;
  predecessors: MainFloor[];
  scores: Score[];
  evidence?: FloorEvidence[];
}): MainFloor {
  const validatedSourceSha = validSourceSha(sourceSha);
  assert.ok(predecessors.length > 0, "missing predecessor floor");
  const ids = new Set<string>();
  for (const predecessor of predecessors) {
    validateFloor(oracle, predecessor);
    for (const id of predecessor.floorIds) ids.add(id);
  }
  for (const score of scores) for (const id of scoreFloor(oracle, score)) ids.add(id);
  const floorIds = Array.from(ids).sort();
  return validateFloor(oracle, {
    schema: 1,
    kind: "main-floor",
    sourceSha: validatedSourceSha,
    identity: oracle.identity,
    floorSha256: digest(floorIds),
    floorIds,
    evidence,
  });
}
export function bootstrapFloor(oracle: Oracle, sourceSha: string, score: Score): MainFloor {
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
export function qualification(
  oracle: Oracle,
  floor: MainFloor,
  score: Score,
  binding: Binding,
): Qualification {
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
