// Fixed GNU bash observations and exact, comparable per-case score changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

interface BashObservation {
  status?: number;
  stdout?: string;
  stderr?: string;
  timeout?: boolean;
  outputLimit?: boolean;
  crash?: string;
  [key: string]: unknown;
}
interface OracleCase {
  id: string;
  corpus: string;
  category: string;
  kind?: string;
  excluded?: string;
  bash?: BashObservation;
  [key: string]: unknown;
}
export interface OracleIdentity {
  schema: number;
  caseSet: string;
  oracle: string;
  environment: string;
  sources: string;
  [key: string]: unknown;
}
export interface OracleEnvironment {
  runner?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}
export interface UnsignedOracle {
  schema: number;
  oracle: unknown;
  environment: OracleEnvironment;
  sources: Record<string, unknown>;
  cases: OracleCase[];
  [key: string]: unknown;
}
export interface Oracle extends UnsignedOracle {
  identity: OracleIdentity;
}
export interface ScoreCase {
  id: string;
  corpus: string;
  category: string;
  kind?: string;
  excluded?: string;
  outcome: string;
  actual?: unknown;
  [key: string]: unknown;
}
interface Counts {
  total: number;
  passed: number;
  skipped: number;
}
interface CorpusSummary extends Counts {
  categories: Record<string, Counts>;
}
export type Summary = Record<string, CorpusSummary>;
export interface Score {
  engine?: string;
  identity: OracleIdentity;
  cases: ScoreCase[];
  counts?: Summary;
  [key: string]: unknown;
}
export interface ComparableCase {
  id: string;
  corpus: string;
  category: string;
  kind?: string;
  excluded?: string;
  outcome: string;
  [key: string]: unknown;
}
export interface ComparableScore {
  identity: unknown;
  cases: ComparableCase[];
  engine?: string;
}
interface CorpusDelta {
  before: number;
  after: number;
  gained: string[];
  lost: string[];
  newlyFailing: { id: string; outcome: string }[];
}
export interface ScoreComparison {
  ok: boolean;
  corpora: Record<string, CorpusDelta>;
}
export interface MainPushBinding {
  kind: "main-push";
  sourceSha: string;
  beforeSha: string;
}
export interface PullRequestBinding {
  kind: "pull-request";
  headSha: string;
  testedMergeSha: string;
  baseSha: string;
  mainSha: string;
}
export interface DispatchBinding {
  kind: "workflow-dispatch";
  sourceSha: string;
  beforeSha: string;
}
export type Binding = MainPushBinding | PullRequestBinding | DispatchBinding;
export interface RunBinding {
  runId: number;
  attempt: number;
}
export function assertBinding(value: unknown): asserts value is Binding {
  assertRecord(value);
  if (value.kind === "main-push" || value.kind === "workflow-dispatch") {
    assert.equal(typeof value.sourceSha, "string", "missing main source SHA");
    assert.equal(typeof value.beforeSha, "string", "missing main predecessor SHA");
    return;
  }
  assert.equal(value.kind, "pull-request", "unsupported qualification binding");
  for (const key of ["headSha", "testedMergeSha", "baseSha", "mainSha"])
    assert.equal(typeof value[key], "string", `missing pull request ${key}`);
}
export function assertRunBinding(value: unknown): asserts value is RunBinding {
  assertRecord(value);
  assert.equal(typeof value.runId, "number", "missing run ID");
  assert.equal(typeof value.attempt, "number", "missing run attempt");
}
export interface CompactInput {
  status?: number;
  stdout: Buffer;
  stderr: Buffer;
  timeout?: boolean;
  outputLimit?: boolean;
  crash?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(isRecord(value), "expected an object");
}
export function assertIdentity(value: unknown): asserts value is OracleIdentity {
  assertRecord(value);
  assert.equal(typeof value.schema, "number", "missing identity schema");
  for (const key of ["caseSet", "oracle", "environment", "sources"])
    assert.equal(typeof value[key], "string", `missing identity ${key}`);
}
export function assertScore(value: unknown): asserts value is Score {
  assertRecord(value);
  if (value.engine !== undefined)
    assert.equal(typeof value.engine, "string", "invalid score engine");
  assertIdentity(value.identity);
  assert.ok(Array.isArray(value.cases), "missing score cases");
  for (const item of value.cases) {
    assertRecord(item);
    assert.equal(typeof item.id, "string", "missing score case ID");
    assert.equal(typeof item.corpus, "string", "missing score corpus");
    assert.equal(typeof item.category, "string", "missing score category");
    if (item.kind !== undefined) assert.equal(typeof item.kind, "string", "invalid score kind");
    assert.equal(typeof item.outcome, "string", "missing score outcome");
  }
}
export function assertOracle(value: unknown): asserts value is Oracle {
  assertRecord(value);
  assert.equal(typeof value.schema, "number", "missing oracle schema");
  assertIdentity(value.identity);
  assertRecord(value.environment);
  assertRecord(value.sources);
  assert.ok(Array.isArray(value.cases), "missing oracle cases");
  for (const item of value.cases) {
    assertRecord(item);
    assert.equal(typeof item.id, "string", "missing oracle case ID");
    assert.equal(typeof item.corpus, "string", "missing oracle corpus");
    assert.equal(typeof item.category, "string", "missing oracle category");
    if (item.kind !== undefined) assert.equal(typeof item.kind, "string", "invalid oracle kind");
    if (item.bash !== undefined) assertRecord(item.bash);
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const digest = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const bytesDigest = (
  value: Parameters<ReturnType<typeof createHash>["update"]>[0],
): string => createHash("sha256").update(value).digest("hex");

export function identityFor(oracle: UnsignedOracle): OracleIdentity {
  return {
    schema: oracle.schema,
    caseSet: digest(oracle.cases.map(({ bash, ...item }) => item)),
    oracle: digest({
      executable: oracle.oracle,
      observations: oracle.cases.map((item) => [item.id, item.bash]),
    }),
    environment: digest(oracle.environment),
    sources: digest(oracle.sources),
  };
}
export function sealOracle(oracle: UnsignedOracle): Oracle {
  return { ...oracle, identity: identityFor(oracle) };
}
export function verifyOracle(oracle: Oracle): void {
  assert.equal(oracle.schema, 1, "unsupported oracle schema");
  assert.deepEqual(oracle.identity, identityFor(oracle), "oracle identity mismatch");
  const ids = new Set<string>();
  for (const item of oracle.cases) {
    assert.ok(!ids.has(item.id), `duplicate oracle case ${item.id}`);
    ids.add(item.id);
    if (item.excluded || item.kind !== "builtins-only") continue;
    const bash = item.bash;
    assert.ok(
      bash &&
        typeof bash.status === "number" &&
        Number.isInteger(bash.status) &&
        bash.status >= 0 &&
        bash.status <= 255,
      `invalid oracle status: ${item.id}`,
    );
    for (const stream of ["stdout", "stderr"]) {
      const bytes: unknown = bash[stream];
      assert.ok(typeof bytes === "string", `invalid oracle bytes: ${item.id}`);
      assert.equal(
        Buffer.from(bytes, "base64").toString("base64"),
        bytes,
        `invalid oracle bytes: ${item.id}`,
      );
    }
  }
}
export function summarize(score: {
  cases: Pick<ComparableCase, "corpus" | "category" | "outcome">[];
}): Summary {
  const result: Summary = {};
  for (const item of score.cases) {
    const corpus = (result[item.corpus] ??= { total: 0, passed: 0, skipped: 0, categories: {} });
    const category = (corpus.categories[item.category] ??= { total: 0, passed: 0, skipped: 0 });
    for (const count of [corpus, category]) {
      count.total++;
      count.passed += Number(item.outcome === "pass");
      count.skipped += Number(item.outcome === "skip");
    }
  }
  return result;
}
function indexCases(score: ComparableScore): Map<string, ComparableCase> {
  const cases = new Map(score.cases.map((item) => [item.id, item]));
  assert.equal(cases.size, score.cases.length, "duplicate result case");
  return cases;
}
export function compareScores(
  base: ComparableScore,
  next: ComparableScore,
  { requireMembership = false }: { requireMembership?: boolean } = {},
): ScoreComparison {
  assert.deepEqual(
    next.identity,
    base.identity,
    "incomparable case-set/oracle/environment/source identity",
  );
  const previous = indexCases(base);
  const current = indexCases(next);
  assert.equal(current.size, previous.size, "result case count changed");
  const corpora: Record<string, CorpusDelta> = {};
  for (const [id, before] of previous) {
    const after = current.get(id);
    assert.ok(after, `missing result case: ${id}`);
    assert.equal(after.corpus, before.corpus, `case corpus changed: ${id}`);
    assert.equal(after.category, before.category, `case category changed: ${id}`);
    assert.equal(after.kind, before.kind, `case kind changed: ${id}`);
    assert.equal(after.excluded, before.excluded, `case exclusion changed: ${id}`);
    assert.equal(after.outcome === "skip", before.outcome === "skip", `case skip changed: ${id}`);
    const delta = (corpora[before.corpus] ??= {
      before: 0,
      after: 0,
      gained: [],
      lost: [],
      newlyFailing: [],
    });
    delta.before += Number(before.outcome === "pass");
    delta.after += Number(after.outcome === "pass");
    if (before.outcome === "pass" && after.outcome !== "pass") delta.lost.push(id);
    if (before.outcome !== "pass" && after.outcome === "pass") delta.gained.push(id);
    if (before.outcome === "pass" && after.outcome !== "pass")
      delta.newlyFailing.push({ id, outcome: after.outcome });
  }
  if (requireMembership) {
    const changed = Object.values(corpora).flatMap((row) => row.gained.concat(row.lost));
    assert.equal(
      changed.length,
      0,
      `stale candidate baseline: update pass membership for ${changed.join(", ")}`,
    );
  }
  return { ok: Object.values(corpora).every((row) => row.lost.length === 0), corpora };
}

export function validateScore(oracle: Oracle, score: Score): void {
  for (const item of score.cases)
    assert.ok(
      ["pass", "fail", "skip", "timeout", "crash"].includes(item.outcome),
      `invalid case outcome: ${item.outcome}`,
    );
  if (score.counts)
    assert.deepEqual(score.counts, summarize(score), "stored counts differ from case outcomes");
  const expected: ComparableScore = {
    identity: oracle.identity,
    cases: oracle.cases.map((item) => ({
      id: item.id,
      corpus: item.corpus,
      category: item.category,
      kind: item.kind,
      excluded: item.excluded,
      outcome: item.excluded || item.kind !== "builtins-only" ? "skip" : "fail",
    })),
  };
  compareScores(expected, score);
}

export function compactResult(result: CompactInput, limit = 240) {
  const stream = (bytes: Buffer) =>
    bytes.length <= limit
      ? bytes.toString("base64")
      : {
          base64: bytes.subarray(0, limit).toString("base64"),
          bytes: bytes.length,
          sha256: bytesDigest(bytes),
          prefixBytes: limit,
        };
  return {
    status: result.status,
    stdout: stream(result.stdout),
    stderr: stream(result.stderr),
    ...(result.timeout ? { timeout: true } : {}),
    ...(result.outputLimit ? { outputLimit: true } : {}),
    ...(result.crash ? { crash: result.crash.slice(0, 240) } : {}),
  };
}
