import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface LintBaselineEntry {
  file: string;
  rule: string;
  line: number;
  column: number;
  reason: string;
}

export interface LintDiagnostic {
  file: string;
  rule: string;
  line: number;
  column: number;
  severity: string;
  message: string;
}

interface RawOxlintLabel {
  span?: { line?: unknown; column?: unknown };
}

interface RawOxlintDiagnostic {
  filename?: unknown;
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  labels?: unknown;
}

const lintTargets = ["src", "scripts", "tests", "vite.config.ts", "playwright.config.ts"];
const baselineRelativePath = "quality/lint-baseline.json";
const root = resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function diagnosticKey(item: Pick<LintBaselineEntry, "file" | "rule" | "line" | "column">): string {
  return `${item.file}:${item.line}:${item.column}:${item.rule}`;
}

function parseEntry(raw: unknown, index: number): LintBaselineEntry {
  if (!isRecord(raw)) throw new Error(`Invalid lint baseline entry at index ${index}`);
  const { file, rule, line, column, reason } = raw;
  if (typeof file !== "string" || !file.trim())
    throw new Error(`Invalid file in lint baseline entry at index ${index}`);
  if (typeof rule !== "string" || !rule.trim())
    throw new Error(`Invalid rule in lint baseline entry at index ${index}`);
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1)
    throw new Error(`Invalid line in lint baseline entry at index ${index}`);
  if (typeof column !== "number" || !Number.isInteger(column) || column < 1)
    throw new Error(`Invalid column in lint baseline entry at index ${index}`);
  if (typeof reason !== "string" || !reason.trim() || /[\r\n]/.test(reason))
    throw new Error(`Lint baseline entry at index ${index} requires a nonempty one-line reason`);
  return { file, rule, line, column, reason };
}

export function parseLintBaseline(raw: unknown): LintBaselineEntry[] {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries))
    throw new Error("Invalid lint baseline format");
  const seen = new Set<string>();
  const entries = raw.entries.map((entry, index) => parseEntry(entry, index));
  for (const entry of entries) {
    const key = diagnosticKey(entry);
    if (seen.has(key)) throw new Error(`Duplicate lint baseline entry: ${key}`);
    seen.add(key);
  }
  return entries;
}

export function lintBaseRef(environment: NodeJS.ProcessEnv): string {
  return (
    environment.LINT_BASE_REF ?? (environment.GITHUB_ACTIONS === "true" ? "HEAD^" : "origin/main")
  );
}

export function assertLintBaselineShrinks(
  candidate: readonly LintBaselineEntry[],
  base: readonly LintBaselineEntry[],
): void {
  const allowed = new Set(base.map(diagnosticKey));
  for (const entry of candidate) {
    const key = diagnosticKey(entry);
    if (!allowed.has(key)) throw new Error(`Lint baseline cannot grow: ${key}`);
  }
}

function runGitOutput(directory: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitFileExistsAtRef(directory: string, ref: string, path: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${ref}:${path}`], {
    cwd: directory,
    stdio: "ignore",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

export function verifyLintBaselineAgainstBase(
  directory: string,
  candidate: readonly LintBaselineEntry[],
  ref: string,
  path = baselineRelativePath,
): void {
  runGitOutput(directory, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (gitFileExistsAtRef(directory, ref, path)) {
    const baseText = runGitOutput(directory, ["show", `${ref}:${path}`]);
    assertLintBaselineShrinks(candidate, parseLintBaseline(JSON.parse(baseText)));
    return;
  }
  const priorHistory = runGitOutput(directory, ["log", "-n", "1", "--format=%H", ref, "--", path]);
  if (priorHistory.trim()) {
    assertLintBaselineShrinks(candidate, []);
    return;
  }
  // Initial baseline seeding: every baselined file must be byte-identical to the immutable base.
  const baselinedFiles = Array.from(new Set(candidate.map((entry) => entry.file)));
  for (const file of baselinedFiles) {
    const diff = spawnSync("git", ["diff", "--quiet", ref, "--", file], {
      cwd: directory,
      stdio: "ignore",
    });
    if (diff.error) throw diff.error;
    if (diff.status !== 0)
      throw new Error(`Lint baseline cannot seed modified file relative to ${ref}: ${file}`);
  }
}

function parseDiagnostic(raw: RawOxlintDiagnostic): LintDiagnostic {
  const labels = Array.isArray(raw.labels) ? (raw.labels as RawOxlintLabel[]) : [];
  const span = labels[0]?.span;
  const file = typeof raw.filename === "string" ? raw.filename.replaceAll("\\", "/") : "<unknown>";
  const rule = typeof raw.code === "string" ? raw.code : "<unknown>";
  const line = typeof span?.line === "number" ? span.line : 0;
  const column = typeof span?.column === "number" ? span.column : 0;
  const severity = typeof raw.severity === "string" ? raw.severity : "error";
  const message = typeof raw.message === "string" ? raw.message : "Oxlint diagnostic";
  return { file, rule, line, column, severity, message };
}

export function checkLintDiagnostics(
  diagnostics: readonly LintDiagnostic[],
  baseline: readonly LintBaselineEntry[],
): { unexpected: LintDiagnostic[]; stale: LintBaselineEntry[] } {
  const remaining = new Map(baseline.map((entry) => [diagnosticKey(entry), entry]));
  const unexpected: LintDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    if (diagnostic.severity === "error" && remaining.delete(key)) continue;
    unexpected.push(diagnostic);
  }
  return { unexpected, stale: Array.from(remaining.values()) };
}

function parseOxlintJson(stdout: string): {
  diagnostics: LintDiagnostic[];
  files: number;
  rules: number;
} {
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics))
    throw new Error("Unexpected oxlint JSON output");
  const files = typeof parsed.number_of_files === "number" ? parsed.number_of_files : 0;
  const rules = typeof parsed.number_of_rules === "number" ? parsed.number_of_rules : 0;
  const diagnostics = (parsed.diagnostics as RawOxlintDiagnostic[]).map(parseDiagnostic);
  return { diagnostics, files, rules };
}

function runMain(): void {
  const baselinePath = resolve(root, baselineRelativePath);
  const baseline = parseLintBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
  verifyLintBaselineAgainstBase(root, baseline, lintBaseRef(process.env));
  const bin = resolve(root, "node_modules/.bin/oxlint");
  const args = [
    "--config",
    resolve(root, ".oxlintrc.json"),
    "--deny-warnings",
    "--format",
    "json",
  ].concat(lintTargets);
  const result = spawnSync(bin, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr);
    throw new Error(`oxlint exited with unexpected status ${result.status}`);
  }
  const { diagnostics, files, rules } = parseOxlintJson(result.stdout);
  const { unexpected, stale } = checkLintDiagnostics(diagnostics, baseline);
  if (unexpected.length === 0 && stale.length === 0) {
    console.log(
      `Lint passed (${files} files, ${rules} rules, ${baseline.length} baselined frozen-fuzzer diagnostics).`,
    );
    return;
  }
  for (const item of unexpected)
    console.error(`${item.file}:${item.line}:${item.column}: ${item.message} [${item.rule}]`);
  for (const item of stale)
    console.error(
      `Stale lint baseline entry (remove from quality/lint-baseline.json): ${item.file}:${item.line}:${item.column} [${item.rule}]`,
    );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runMain();
