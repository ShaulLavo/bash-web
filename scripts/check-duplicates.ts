import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const duplicateModes = ["exact", "rust-structural"] as const;
type DuplicateMode = (typeof duplicateModes)[number];
type Reason =
  | { kind: "upstream" | "generated" | "fixture"; reason: string }
  | { kind: "deferred"; reason: string; plan: string };
type Baseline = {
  version: 1;
  fingerprints: Record<string, number>;
  reasons: Record<string, Reason>;
};
type Location = { path: string; start: number; end: number };
type Clone = { fingerprint: string; locations: Location[]; tokens: number };

export function duplicateArgs(
  mode: DuplicateMode,
  baseline: string,
  paths: readonly string[],
  update = false,
): string[] {
  if (!duplicateModes.includes(mode)) throw new Error(`Unknown duplicate scan: ${mode}`);
  const common = [
    "--mode",
    "mild",
    "--min-lines",
    "5",
    "--min-tokens",
    "50",
    "--ignore",
    "**/target/**,**/fixtures/**,**/vendor/**",
    "--pattern",
    "**/*.{rs,ts,tsx,js,mjs,cjs}",
    "--workers",
    "2",
    "--no-colors",
    "--no-tips",
    "--reporters",
    "console",
    "--baseline",
    baseline,
    "--fail-on-empty",
  ];
  const detection =
    mode === "exact"
      ? ["--kind", "exact", "--format", "rust,typescript,tsx,javascript"]
      : ["--kind", "ast", "--format", "rust", "--similarity", "0.8", "--min-nodes", "20"];
  return common.concat(
    detection,
    update ? ["--update-baseline"] : ["--fail-on-new-clones", "0"],
    paths,
  );
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  return value as Record<string, unknown>;
}

function oneLine(value: unknown): string {
  assert.ok(
    typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value),
    "A nonempty one-line reason is required",
  );
  return value;
}

function fingerprints(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, count]) => {
      assert.match(key, /^[a-f0-9]{16}$/, "Invalid clone fingerprint");
      assert.ok(
        typeof count === "number" && Number.isSafeInteger(count) && count > 0,
        `Invalid clone count for ${key}`,
      );
      return [key, count];
    }),
  );
}

function parseReason(value: unknown): Reason {
  const entry = object(value);
  const reason = oneLine(entry.reason);
  if (entry.kind === "deferred") return { kind: entry.kind, reason, plan: oneLine(entry.plan) };
  assert.ok(
    entry.kind === "upstream" || entry.kind === "generated" || entry.kind === "fixture",
    "Reason kind must be upstream, generated, fixture, or deferred",
  );
  return { kind: entry.kind, reason };
}

export function parseDuplicateBaseline(value: unknown): Baseline {
  const data = object(value);
  assert.equal(data.version, 1, "Unknown duplicate baseline version");
  const counts = fingerprints(data.fingerprints);
  const reasons = Object.fromEntries(
    Object.entries(object(data.reasons)).map(([key, value]) => [key, parseReason(value)]),
  );
  for (const key of Object.keys(counts))
    assert.ok(reasons[key], `Missing reason for baseline clone ${key}`);
  for (const key of Object.keys(reasons))
    assert.ok(counts[key], `Reason without a baseline clone ${key}`);
  return { version: 1, fingerprints: counts, reasons };
}

export function validateDuplicatePlans(baseline: Baseline, directory: string) {
  const plans = new Set(
    Object.values(baseline.reasons).flatMap((entry) =>
      entry.kind === "deferred" ? [entry.plan] : [],
    ),
  );
  for (const plan of plans) {
    assert.match(
      plan,
      /^plans\/[a-z0-9-]+\.md#[a-z0-9-]+$/,
      "Deferred clone needs an exact local plan item",
    );
    const [path, anchor] = plan.split("#");
    const text = readFileSync(resolve(directory, path), "utf8");
    assert.match(text, /^Status: Approved$/m, `${path} must be Approved`);
    assert.ok(text.includes(`<a id="${anchor}"></a>`), `Missing removal item ${plan}`);
  }
}

export function assertBaselineShrinks(
  candidate: Readonly<Record<string, number>>,
  base: Readonly<Record<string, number>>,
) {
  for (const [fingerprint, count] of Object.entries(candidate)) {
    assert.ok(
      count <= (base[fingerprint] ?? 0),
      `Duplicate baseline cannot grow: ${fingerprint} (${base[fingerprint] ?? 0} -> ${count})`,
    );
  }
}

export function shrinkDuplicateBaseline(
  baseline: Baseline,
  current: Readonly<Record<string, number>>,
): Baseline {
  assertBaselineShrinks(current, baseline.fingerprints);
  return {
    version: 1,
    fingerprints: { ...current },
    reasons: Object.fromEntries(Object.keys(current).map((key) => [key, baseline.reasons[key]])),
  };
}

function location(value: unknown, directory: string): Location {
  const physical = object(object(value).physicalLocation);
  const artifact = object(physical.artifactLocation);
  const region = object(physical.region);
  assert.ok(
    typeof artifact.uri === "string" &&
      typeof region.startLine === "number" &&
      typeof region.endLine === "number",
    "Invalid jscpd location",
  );
  return { path: relative(directory, artifact.uri), start: region.startLine, end: region.endLine };
}

function readClones(path: string, directory: string): Clone[] {
  const report = object(JSON.parse(readFileSync(path, "utf8")));
  assert.ok(Array.isArray(report.runs) && report.runs.length === 1, "Expected one jscpd SARIF run");
  const run = object(report.runs[0]);
  assert.ok(Array.isArray(run.results), "Missing jscpd results");
  return run.results.map((value: unknown) => {
    const item = object(value);
    const fingerprint = object(item.partialFingerprints)["jscpdCloneHash/v1"];
    const tokens = object(item.properties).token_count;
    assert.ok(
      typeof fingerprint === "string" && typeof tokens === "number",
      "Missing jscpd fingerprint or token count",
    );
    assert.ok(
      Array.isArray(item.locations) && Array.isArray(item.relatedLocations),
      "Missing clone locations",
    );
    return {
      fingerprint,
      tokens,
      locations: item.locations
        .concat(item.relatedLocations)
        .map((entry: unknown) => location(entry, directory)),
    };
  });
}

function countClones(clones: readonly Clone[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const clone of clones) counts[clone.fingerprint] = (counts[clone.fingerprint] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function scan(mode: DuplicateMode, baselinePath: string, directory: string, scratch: string) {
  const paths = mode === "exact" ? ["src", "scripts", "shell", "tests"] : ["shell"];
  const args = duplicateArgs(mode, baselinePath, paths);
  args[args.indexOf("console")] = "console,sarif";
  const output = resolve(scratch, mode);
  args.push("--absolute", "--output", output);
  const result = spawnSync(resolve(root, "node_modules/.bin/jscpd"), args, {
    cwd: directory,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    clones: readClones(resolve(output, "jscpd-report.sarif"), directory),
  };
}

function reportMode(mode: DuplicateMode, baseline: Baseline, clones: readonly Clone[]) {
  const current = countClones(clones);
  const categories: Record<string, number> = {};
  for (const clone of clones) {
    const category = baseline.reasons[clone.fingerprint]?.kind ?? "unexplained";
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return {
    mode,
    baselineOccurrences: Object.values(baseline.fingerprints).reduce(
      (sum, count) => sum + count,
      0,
    ),
    baselineFingerprints: Object.keys(baseline.fingerprints).length,
    currentOccurrences: clones.length,
    currentFingerprints: Object.keys(current).length,
    categories,
    stale: Object.keys(baseline.fingerprints).filter((key) => !current[key]),
    clones: clones.map((clone) => ({
      ...clone,
      disposition: baseline.reasons[clone.fingerprint] ?? null,
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex < 0 ? undefined : args.splice(reportIndex, 2)[1];
  if (reportIndex >= 0 && (!reportPath || reportPath.startsWith("--")))
    throw new Error("--report needs a file path");
  if (args.some((arg) => arg !== "--record"))
    throw new Error("Only --record and --report PATH are supported");
  const parent = resolve(root, ".scratch");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "duplicate-scan-"));
  try {
    checkModes(scratch, args.includes("--record"), reportPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function duplicateBaseRef(environment: NodeJS.ProcessEnv): string {
  return (
    environment.DUPLICATES_BASE_REF ??
    (environment.GITHUB_ACTIONS === "true" ? "HEAD^" : "origin/main")
  );
}

export function duplicateComparison(
  directory: string,
  path: string,
  ref: string,
): Record<string, number> {
  const text = execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return fingerprints(object(JSON.parse(text)).fingerprints);
}

function checkModes(scratch: string, record: boolean, reportPath?: string) {
  const results = duplicateModes.map((mode) => {
    const path = `quality/duplicates-${mode}.json`;
    const baseline = parseDuplicateBaseline(JSON.parse(readFileSync(resolve(root, path), "utf8")));
    validateDuplicatePlans(baseline, root);
    assertBaselineShrinks(
      baseline.fingerprints,
      duplicateComparison(root, path, duplicateBaseRef(process.env)),
    );
    console.log(`Duplicate scan: ${mode}`);
    return { mode, path, baseline, ...scan(mode, path, root, scratch) };
  });
  if (reportPath)
    writeFileSync(
      resolve(root, reportPath),
      JSON.stringify(
        results.map(({ mode, baseline, clones }) => reportMode(mode, baseline, clones)),
        null,
        2,
      ) + "\n",
    );
  process.exitCode = results.some(({ status }) => status !== 0) ? 1 : 0;
  if (!record || process.exitCode !== 0) return;
  for (const { path, baseline, clones } of results) {
    writeFileSync(
      resolve(root, path),
      JSON.stringify(shrinkDuplicateBaseline(baseline, countClones(clones)), null, 2) + "\n",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
