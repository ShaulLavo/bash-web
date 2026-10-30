// Runs the pinned shell spec corpora through GNU bash and the standalone WASM shell.
// Bash is the oracle: a case passes when stdout and exit status match bash exactly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { buildWasiShell } from "./wasi-build.ts";
import { compatibilityPrograms } from "./compat-programs.ts";
import { pythonHelpers } from "./bash-compat-helpers.ts";
import {
  bashStderrTransport,
  bashStdoutTransport,
  createShellRunner,
  normalize,
} from "./bash-compat-runner.ts";
import { cancelTargetMigrations, targetBranchBaseline } from "./shell-scoreboard-base.ts";
import {
  assertOracle,
  assertScore,
  bytesDigest,
  compactResult,
  digest,
  sealOracle,
  verifyOracle,
  summarize,
  compareScores,
  validateScore,
} from "./shell-scoreboard.ts";
import type { ActiveChildren, BufferedResult, ShellResult } from "./bash-compat-runner.ts";
import type { Oracle as CoreOracle, Score as CoreScore } from "./shell-scoreboard.ts";

type Corpus = "oils" | "brush-suite" | "bashkit-suite";
type EngineName = "own-shell";
type CaseKind = "builtins-only" | "needs-commands";
type Outcome = "pass" | "fail" | "timeout" | "crash" | "missing-command";

interface JudgedResult {
  outcome: Outcome;
  stderrAgrees?: boolean;
  missing?: string[];
  status?: number;
  stdout?: string;
  stderr?: string;
  crash?: string;
}

interface CompatCase {
  corpus: Corpus;
  file: string;
  line?: number;
  name: string;
  code: string;
  category?: string;
  kind?: CaseKind;
  excluded?: string;
  described?: boolean;
  needs?: string[];
  bash?: ShellResult;
  results?: Record<string, JudgedResult>;
}

interface ParsedCase {
  line: number;
  name: string;
  code: string;
}

interface SpotCheck {
  name: string;
  code: string;
  bash?: ShellResult;
  results?: Record<string, string>;
}

interface PackedResult {
  status: number;
  stdout: string;
  stderr: string;
  timeout?: boolean;
  outputLimit?: boolean;
  crash?: string;
  [key: string]: unknown;
}

interface OracleCase {
  id: string;
  corpus: Corpus;
  file: string;
  line: number;
  name: string;
  category: string;
  code: string;
  kind?: CaseKind;
  excluded?: string;
  needs?: string[];
  bash: PackedResult;
  [key: string]: unknown;
}

interface CaptureRecord {
  id: string;
  corpus: Corpus;
  file: string;
  line: number;
  name: string;
  category: string;
  code: string;
  kind?: CaseKind;
  excluded?: string;
  needs?: string[];
  bash?: PackedResult;
  [key: string]: unknown;
}

interface Oracle extends CoreOracle {
  sources: Record<Corpus, { revision: string }> & Record<string, unknown>;
  environment: { nodeVersion: string; [key: string]: unknown };
  cases: OracleCase[];
}

interface ScoreCase {
  id: string;
  corpus: Corpus;
  category: string;
  kind?: CaseKind;
  outcome: string;
  excluded?: string;
  actual?: unknown;
  [key: string]: unknown;
}

interface Score extends CoreScore {
  cases: ScoreCase[];
  engine: string;
}

interface SourcePin {
  repository?: string;
  revision: string;
  archiveSha256?: string;
}

interface Pins {
  oils: SourcePin;
  brush: { revision: string };
  bashkitTerminal: { revision: string };
  shellScoreboard?: { oracleSha256: string };
}

interface PoolResult extends BufferedResult {
  cancelled?: boolean;
  dead?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCorpus(value: unknown): value is Corpus {
  return value === "oils" || value === "brush-suite" || value === "bashkit-suite";
}

function validatePin(value: unknown): asserts value is SourcePin {
  if (!isRecord(value)) throw new Error("Invalid source pin");
  if (value.repository !== undefined && typeof value.repository !== "string")
    throw new Error("Invalid source repository");
  if (typeof value.revision !== "string") throw new Error("Invalid source revision");
  if (value.archiveSha256 !== undefined && typeof value.archiveSha256 !== "string")
    throw new Error("Invalid source archive checksum");
}

function validatePins(value: unknown): asserts value is Pins {
  if (!isRecord(value)) throw new Error("Invalid sources.lock.json");
  validatePin(value.oils);
  if (!isRecord(value.brush) || typeof value.brush.revision !== "string")
    throw new Error("Invalid Brush pin");
  if (!isRecord(value.bashkitTerminal) || typeof value.bashkitTerminal.revision !== "string")
    throw new Error("Invalid Bashkit pin");
  if (value.shellScoreboard === undefined) return;
  if (!isRecord(value.shellScoreboard) || typeof value.shellScoreboard.oracleSha256 !== "string")
    throw new Error("Invalid shell scoreboard pin");
}

function assertBashOracle(value: CoreOracle): asserts value is Oracle {
  assert.equal(typeof value.environment.nodeVersion, "string", "Invalid oracle Node version");
  for (const corpus of ["oils", "brush-suite", "bashkit-suite"]) {
    assert.ok(isRecord(value.sources[corpus]));
    assert.equal(typeof value.sources[corpus].revision, "string", "Invalid oracle source revision");
  }
  for (const item of value.cases) {
    assert.equal(typeof item.file, "string", "Invalid oracle case file");
    assert.equal(typeof item.line, "number", "Invalid oracle case line");
    assert.equal(typeof item.name, "string", "Invalid oracle case name");
    assert.equal(typeof item.code, "string", "Invalid oracle case code");
    assert.ok(item.bash, "Missing oracle observation");
  }
}
function validatedOracle(value: unknown): Oracle {
  assertOracle(value);
  verifyOracle(value);
  assertBashOracle(value);
  return value;
}

function assertBashScore(value: CoreScore): asserts value is Score {
  assert.equal(value.engine, "own-shell", "Invalid score engine");
  for (const item of value.cases) assert.ok(isCorpus(item.corpus), "Invalid score corpus");
}
function validatedScore(oracle: CoreOracle, value: unknown): Score {
  assertScore(value);
  validateScore(oracle, value);
  assertBashScore(value);
  return value;
}

interface ClassificationCase {
  corpus: Corpus;
  file: string;
  line: number;
  name: string;
  kind?: CaseKind;
  excluded?: string;
  needs?: string[];
}

function parseClassification(value: unknown): ClassificationCase[] {
  if (!isRecord(value) || !Array.isArray(value.cases))
    throw new Error("Invalid published compatibility classification");
  return value.cases.map((entry: unknown) => {
    if (!isRecord(entry) || !isCorpus(entry.corpus))
      throw new Error("Invalid published compatibility case");
    if (typeof entry.file !== "string" || typeof entry.line !== "number")
      throw new Error("Invalid case location");
    if (typeof entry.name !== "string") throw new Error("Invalid case name");
    if (
      entry.kind !== undefined &&
      entry.kind !== null &&
      entry.kind !== "builtins-only" &&
      entry.kind !== "needs-commands"
    )
      throw new Error("Invalid case kind");
    if (
      entry.excluded !== undefined &&
      entry.excluded !== null &&
      typeof entry.excluded !== "string"
    )
      throw new Error("Invalid case exclusion");
    if (entry.needs !== undefined && entry.needs !== null && !Array.isArray(entry.needs))
      throw new Error("Invalid case commands");
    const needs = entry.needs?.map((need: unknown) => {
      if (typeof need !== "string") throw new Error("Invalid case command");
      return need;
    });
    return {
      corpus: entry.corpus,
      file: entry.file,
      line: entry.line,
      name: entry.name,
      kind: entry.kind ?? undefined,
      excluded: entry.excluded ?? undefined,
      needs,
    };
  });
}

interface BrushSuite {
  cases: Record<string, unknown>[];
  commonTestFiles: unknown;
}

function parseBrushSuite(value: unknown): BrushSuite {
  if (!isRecord(value)) throw new Error("Invalid Brush compatibility suite");
  if (value.cases !== undefined && value.cases !== null && !Array.isArray(value.cases))
    throw new Error("Invalid Brush case list");
  const cases = (value.cases ?? []).map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error("Invalid Brush compatibility case");
    if (entry.name !== undefined && entry.name !== null && typeof entry.name !== "string")
      throw new Error("Invalid Brush case name");
    if (entry.stdin !== undefined && entry.stdin !== null && typeof entry.stdin !== "string")
      throw new Error("Invalid Brush case source");
    return entry;
  });
  return { cases, commonTestFiles: value.common_test_files };
}

const root = resolve(import.meta.dirname, "..");
const rawPins: unknown = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
validatePins(rawPins);
const pins: Pins = rawPins;
const mode = process.env.BASH_COMPAT_MODE ?? "live";
if (!["live", "capture", "frozen"].includes(mode))
  throw new Error(`Unknown compatibility mode: ${mode}`);
const timeoutMs = Number(process.env.BASH_COMPAT_TIMEOUT_MS ?? 10000);
const oracleFile = resolve(
  root,
  process.env.BASH_COMPAT_ORACLE ?? "docs/evidence/own-shell-oracle.json",
);
const baselineFile = resolve(
  root,
  process.env.BASH_COMPAT_BASELINE ?? "docs/evidence/own-shell-baseline.json",
);
const sourceFiles: Partial<Record<Corpus, Record<string, string>>> = {};
const brushCorpus = resolve(root, process.env.BASH_COMPAT_BRUSH_DIR ?? ".sources/brush");
const bashkitCorpus = resolve(root, process.env.BASH_COMPAT_BASHKIT_DIR ?? ".sources/bashkit");
const jobs = Number(
  process.env.BASH_COMPAT_JOBS ?? Math.min(4, Math.max(2, availableParallelism() >> 1)),
);
const onlyFiles = process.env.BASH_COMPAT_FILES?.split(",").filter(Boolean);
const corpusNames = (process.env.BASH_COMPAT_CORPORA ?? "oils,brush-suite,bashkit-suite").split(
  ",",
);
const output = resolve(
  root,
  process.env.BASH_COMPAT_OUT ?? "docs/evidence/bash-compatibility.json",
);
const bashPath = process.env.BASH_COMPAT_BASH ?? "/usr/bin/bash";
const virtualTmp = "/tmp/spec";
const virtualHome = "/home/user";

const engines: Record<EngineName, { modulePath: string }> = {
  "own-shell": {
    modulePath: resolve(
      root,
      process.env.BASH_COMPAT_SHELL_WASM ??
        `${process.env.CARGO_TARGET_DIR ?? ".build/shell"}/wasm32-wasip1/release/shell-runtime.wasm`,
    ),
  },
};
function isEngineName(name: string): name is EngineName {
  return name in engines;
}
const requestedEngines = process.env.BASH_COMPAT_ENGINES?.split(",") ?? ["own-shell"];
if (!requestedEngines.length || requestedEngines.some((name) => !isEngineName(name)))
  throw new Error(`Unknown compatibility engines: ${requestedEngines.join(",")}`);
const engineNames = requestedEngines.filter(isEngineName);
if (
  !Number.isInteger(jobs) ||
  jobs < 1 ||
  jobs > 32 ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1
)
  throw new Error("Set BASH_COMPAT_JOBS to 1..32 and BASH_COMPAT_TIMEOUT_MS to a positive integer");
if (
  mode !== "live" &&
  (onlyFiles || process.env.BASH_COMPAT_CORPORA || engineNames.join(",") !== "own-shell")
)
  throw new Error("Fixed scoreboard requires own-shell and the complete fixed case set");

// Every non-YSH Oils spec file that compares against bash, grouped by subject.
const categories = {
  "Quoting and word splitting": [
    "quote",
    "word-split",
    "word-eval",
    "whitespace",
    "comments",
    "var-sub-quote",
    "tilde",
    "unicode",
    "nul-bytes",
  ],
  "Parameter expansion": [
    "var-op-bash",
    "var-op-len",
    "var-op-patsub",
    "var-op-slice",
    "var-op-strip",
    "var-op-test",
    "var-sub",
    "var-num",
    "var-ref",
    "nameref",
  ],
  "Brace expansion": ["brace-expansion"],
  Arithmetic: ["arith", "arith-context", "arith-dynamic", "dparen", "let", "for-expr"],
  "Arrays and assoc arrays": [
    "array",
    "array-assign",
    "array-assoc",
    "array-basic",
    "array-compat",
    "array-literal",
    "array-sparse",
    "append",
    "type-compat",
  ],
  "Assignment, scope and special vars": [
    "assign",
    "assign-deferred",
    "assign-dialects",
    "assign-extended",
    "temp-binding",
    "vars-special",
    "vars-bash",
    "builtin-vars",
  ],
  "Command substitution and subshells": ["command-sub", "subshell", "process-sub"],
  "Globbing and extglob": [
    "glob",
    "glob-bash",
    "globignore",
    "globstar",
    "extglob-files",
    "extglob-match",
    "nocasematch-match",
  ],
  "Conditionals, test, [[ ]] and case": [
    "dbracket",
    "builtin-bracket",
    "bool-parse",
    "regex",
    "if_",
    "case_",
  ],
  "Grammar, functions and control flow": [
    "loop",
    "sh-func",
    "func-parsing",
    "empty-bodies",
    "command_",
    "command-parsing",
    "shell-grammar",
    "paren-ambiguity",
    "explore-parsing",
    "parse-errors",
    "posix",
    "smoke",
    "exit-status",
    "fatal-errors",
    "toysh",
    "toysh-posix",
  ],
  "Here-docs and redirects": ["here-doc", "redirect", "redirect-command", "redirect-multi"],
  Pipelines: ["pipeline"],
  "errexit, options and traps": [
    "errexit",
    "errexit-osh",
    "strict-options",
    "sh-options",
    "sh-options-bash",
    "builtin-set",
    "builtin-trap",
    "builtin-trap-bash",
    "builtin-trap-err",
  ],
  "echo, printf, read, mapfile, getopts": [
    "builtin-echo",
    "builtin-printf",
    "builtin-read",
    "builtin-bash",
    "builtin-getopts",
  ],
  "Other builtins (cd, eval, source, type, alias...)": [
    "builtin-cd",
    "builtin-dirs",
    "builtin-eval-source",
    "builtin-meta",
    "builtin-meta-assign",
    "builtin-misc",
    "builtin-special",
    "builtin-type",
    "builtin-type-bash",
    "alias",
    "introspect",
    "serialize",
    "print-source-code",
    "arg-parse",
  ],
  "Real-world idioms": [
    "ble-features",
    "ble-idioms",
    "ble-unset",
    "blog1",
    "blog2",
    "blog-other1",
    "bugs",
    "nix-idioms",
    "divergence",
    "known-differences",
    "shell-bugs",
    "zsh-idioms",
  ],
};
const excludedFiles = {
  "Interactive editing, history, completion and prompts; not a script feature": [
    "builtin-completion",
    "builtin-bind",
    "builtin-fc",
    "builtin-history",
    "history-expand",
    "interactive",
    "interactive-parse",
    "prompt",
  ],
  "Job control, signals between processes, ulimit/umask/times": [
    "background",
    "builtin-kill",
    "builtin-process",
    "builtin-times",
    "builtin-umask",
  ],
  "Shell executable flags (`$SH -n`, `-i`, `-o` ...), no in-process equivalent": ["sh-usage"],
  "xtrace output goes only to stderr, which is not scored": ["xtrace"],
  "No bash in the file's compare_shells (zsh, mksh or OSH only)": [
    "zsh-assoc",
    "command-sub-ksh",
    "redir-order",
    "osh-bugs",
    "spec-harness-bug",
  ],
};

const commonCommands = [
  "cat",
  "ls",
  "mkdir",
  "rm",
  "rmdir",
  "cp",
  "mv",
  "touch",
  "ln",
  "chmod",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "paste",
  "tee",
  "grep",
  "sed",
  "awk",
  "find",
  "xargs",
  "date",
  "seq",
  "env",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "diff",
  "od",
  "hexdump",
  "base64",
  "md5sum",
  "sha256sum",
  "expr",
  "jq",
  "tac",
  "rev",
  "nl",
  "fold",
  "printf",
  "echo",
  "test",
  "true",
  "false",
  "sleep",
  "which",
  "file",
  "du",
  "df",
  "tar",
  "gzip",
  "curl",
  "python3",
  "bash",
  "sh",
];

const spotChecks = [
  ["grep -E alternation", "grep -E 'ap|an' fruits"],
  ["grep -o -n -i", "grep -o -n -i 'AN' fruits"],
  ["grep -c -v -w", "grep -c -v -w apple fruits"],
  ["grep -r with --include", "grep -r --include='*.txt' -l fig ."],
  ["sed s///g with -E groups", "sed -E 's/(a)(n)/\\2\\1/g' fruits"],
  ["sed -n range print", "sed -n '2,3p' fruits"],
  ["sed delete and insert", "sed -e '/fig/d' -e '1i head' fruits"],
  ["sed -i in place", "sed -i 's/apple/APPLE/' fruits; cat fruits"],
  ["awk fields and sum", "awk -F, '{s+=$2} END {print s, NR}' prices"],
  [
    "awk printf and arrays",
    "awk -F, '{c[$1]++} END {for (k in c) printf \"%s=%d\\n\", k, c[k]}' prices | sort",
  ],
  ["awk regex and substr", "awk '/an/ {print toupper(substr($0, 1, 3))}' fruits"],
  ["sort -n -r", "printf '10\\n9\\n100\\n' | sort -n -r"],
  ["sort -t -k -u", "sort -t, -k2,2n -u prices"],
  ["uniq -c", "sort fruits fruits | uniq -c"],
  ["cut and tr", "cut -d, -f1 prices | tr a-z A-Z"],
  ["head and tail", "head -n 2 fruits; tail -n 1 fruits"],
  ["wc -l -w", "wc -l -w < fruits"],
  ["find -name -type", "find . -name '*.txt' -type f | sort"],
  ["find -maxdepth", "find . -maxdepth 1 -type d | sort"],
  ["xargs -n", "printf 'a b c d\\n' | xargs -n 2 echo"],
  ["jq field", "printf '{\"a\":{\"b\":[1,2,3]}}' | jq '.a.b[1]'"],
  [
    "jq -r map select",
    'printf \'[{"n":"x","v":1},{"n":"y","v":2}]\' | jq -r \'.[] | select(.v > 1) | .n\'',
  ],
  ["jq -c transform", "printf '[1,2,3]' | jq -c 'map(. * 2) | {sum: add}'"],
];
const spotSetup =
  "printf 'apple\\nbanana\\ncherry\\nfig\\n' > fruits; printf 'apple,3\\nfig,2\\napple,5\\n' > prices; " +
  "mkdir -p d/e; printf 'fig\\n' > d/a.txt; printf 'fig\\n' > d/e/b.txt; printf 'x\\n' > d/c.md; ";

const scratchRoot = process.env.BASH_COMPAT_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp";
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, "bash-web-compat-"));
const pools: Pool[] = [];
const activeChildren: ActiveChildren = new Map();
const runShell = createShellRunner({ scratch, timeoutMs, activeChildren });
let cancelled = false;
let shutdown: Promise<unknown> = Promise.resolve();
const killAll = () => {
  for (const kill of activeChildren.keys()) kill();
};
const closePools = () => Promise.allSettled(pools.map((pool) => pool.close()));
const stop = (status: number) => {
  cancelled = true;
  process.exitCode = status;
  killAll();
  cancelTargetMigrations();
  shutdown = shutdown.then(closePools);
};
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("exit", killAll);

async function main() {
  if (cancelled) return;
  if (mode === "frozen") return runFrozen();
  const corpus = corpusNames.includes("oils") ? await prepareCorpus() : undefined;
  if (cancelled) return;
  if (mode === "live") prepareEngines();
  const helperDirectory = resolve(scratch, "helpers");
  await mkdir(helperDirectory);
  for (const [name, source] of Object.entries(pythonHelpers)) {
    await writeFile(resolve(helperDirectory, name), source);
    await chmod(resolve(helperDirectory, name), 0o755);
  }
  const bashVersion = execFileSync(bashPath, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const cases = (await loadOilsCases(corpus)).concat(
    await loadBrushCases(),
    await loadBashkitCases(),
  );
  if (cancelled) return;
  if (mode === "capture") return captureOracle(cases, helperDirectory, bashVersion);
  for (const name of corpusNames)
    log(`${name}: ${cases.filter((item) => item.corpus === name).length} cases`);

  const fullPath = `${helperDirectory}:/usr/local/bin:/usr/bin:/bin`;
  await mapLimit(cases, jobs * 2, async (item) => {
    if (cancelled || item.excluded) return;
    const first = await runShell(bashPath, item.code, fullPath);
    if (cancelled) return;
    const second = await runShell(bashPath, item.code, fullPath);
    if (cancelled) return;
    const builtinsOnly = await runShell(bashPath, item.code, helperDirectory);
    if (cancelled) return;
    item.bash = first;
    if (first.timeout) item.excluded = "bash timed out";
    else if (!same(first, second)) item.excluded = "bash output is not deterministic";
    else if (!same(first, builtinsOnly)) {
      item.kind = "needs-commands";
      item.needs = Array.from(
        new Set(
          Array.from(
            builtinsOnly.stderr.toString("latin1").matchAll(/: ([^\s:]+): command not found/g),
            (match) => match[1],
          ),
        ),
      ).sort();
    } else item.kind = "builtins-only";
  });
  if (cancelled) return;
  log("bash oracle done");

  const spots: SpotCheck[] = spotChecks.map(([name, code]) => ({ name, code: spotSetup + code }));
  await mapLimit(spots, jobs, async (spot) => {
    if (cancelled) return;
    spot.bash = await runShell(bashPath, spot.code, fullPath);
  });
  if (cancelled) return;

  const inventoryNames = Array.from(
    new Set(commonCommands.concat(cases.flatMap((item) => item.needs ?? []))),
  ).sort();
  const inventoryScript = `for n in ${inventoryNames.map(shellQuote).join(" ")}; do command -v "$n" >/dev/null 2>&1 && echo "$n"; done`;

  const inventories: Record<EngineName, string[]> = { "own-shell": [] };
  for (const engine of engineNames) {
    if (cancelled) return;
    const pool = new Pool(engine, jobs);
    pools.push(pool);
    const inventory = await pool.run(inventoryScript);
    if (cancelled) return;
    inventories[engine] = inventory.stdout.toString("utf8").split("\n").filter(Boolean);
    const available = new Set(inventories[engine]);
    let done = 0;
    await mapLimit(cases, jobs, async (item) => {
      if (cancelled || item.excluded) return;
      const actual = await pool.run(item.code);
      if (cancelled) return;
      item.results ??= {};
      item.results[engine] = judge(item, actual, available);
      if (++done % 250 === 0) log(`${engine}: ${done}`);
    });
    await mapLimit(spots, jobs, async (spot) => {
      if (cancelled) return;
      const actual = await pool.run(spot.code);
      if (cancelled) return;
      spot.results ??= {};
      if (!spot.bash) throw new Error(`Missing Bash result for ${spot.name}`);
      let outcome = "fail";
      if (same(spot.bash, normalizeResult(actual))) outcome = "pass";
      else if (actual.timeout) outcome = "timeout";
      spot.results[engine] = outcome;
    });
    await pool.close();
    if (cancelled) return;
    log(`${engine} done`);
  }

  const evidence = buildEvidence({ bashVersion, cases, spots, inventories, inventoryNames });
  if (cancelled) return;
  // One line per case keeps the evidence file reviewable in diffs.
  const rows = evidence.cases.map((item) => JSON.stringify(item)).join(",\n");
  await writeFile(
    output,
    JSON.stringify({ ...evidence, cases: "CASES" }, null, 1).replace(
      '"CASES"',
      () => `[\n${rows}\n]`,
    ) + "\n",
  );
  console.log(renderSummary(evidence));
  log(`wrote ${output}`);
}

async function prepareCorpus(): Promise<string> {
  const pin = pins.oils;
  const destination = resolve(root, ".sources/oils");
  const marker = resolve(destination, ".revision");
  const current = await readFile(marker, "utf8").catch(() => "");
  if (current.trim() !== pin.revision) {
    log(`downloading Oils ${pin.revision}`);
    const response = await fetch(
      `https://codeload.github.com/oils-for-unix/oils/tar.gz/${pin.revision}`,
    );
    if (!response.ok) throw new Error(`Oils source download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (typeof pin.archiveSha256 !== "string") throw new Error("Missing Oils archive checksum");
    if (createHash("sha256").update(bytes).digest("hex") !== pin.archiveSha256)
      throw new Error("Oils source archive checksum mismatch");
    const archive = resolve(scratch, "oils.tar.gz");
    await writeFile(archive, bytes);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      archive,
      "--strip-components=1",
      "-C",
      destination,
      "--wildcards",
      `oils-${pin.revision}/spec/*.test.sh`,
      `oils-${pin.revision}/LICENSE.txt`,
    ]);
    await writeFile(marker, pin.revision);
  }
  return destination;
}

function prepareEngines() {
  if (process.env.BASH_COMPAT_SKIP_BUILD === "1") return;
  buildWasiShell(["--workspace"]);
}

async function loadOilsCases(corpus: string | undefined): Promise<CompatCase[]> {
  if (!corpusNames.includes("oils")) return [];
  if (!corpus) throw new Error("Oils corpus was not prepared");
  const listed = new Map(
    Object.entries(categories).flatMap(([category, files]) =>
      files.map((file) => [file, category]),
    ),
  );
  const available = (await readdir(resolve(corpus, "spec")))
    .filter((name) => name.endsWith(".test.sh"))
    .map((name) => basename(name, ".test.sh"));
  const known = new Set(Array.from(listed.keys()).concat(Object.values(excludedFiles).flat()));
  for (const name of available) {
    const text = await readFile(resolve(corpus, "spec", `${name}.test.sh`), "utf8");
    const compare = /^## compare_shells:(.*)$/m.exec(text)?.[1] ?? "";
    const isOils = name.startsWith("ysh-") || name.startsWith("hay");
    if (!isOils && /\bbash\b/.test(compare) && !known.has(name))
      throw new Error(`Unclassified bash spec file: ${name}`);
  }
  const cases: CompatCase[] = [];
  for (const [file, category] of listed) {
    if (onlyFiles && !onlyFiles.includes(file)) continue;
    const text = await corpusText(
      "oils",
      `spec/${file}.test.sh`,
      resolve(corpus, "spec", `${file}.test.sh`),
    );
    for (const parsed of parseSpecFile(text))
      cases.push({
        corpus: "oils",
        file,
        category,
        ...parsed,
        excluded: parsed.code.includes("REPO_ROOT") ? "reads Oils repository test data" : undefined,
      });
  }
  return cases;
}

// Secondary signal: Brush's own bash-comparison cases. Only cases defined by a script alone
// are used; cases with arguments, files, environment, terminals or skips are left out.
async function loadBrushCases(): Promise<CompatCase[]> {
  if (!corpusNames.includes("brush-suite")) return [];
  const directory = resolve(brushCorpus, "brush-shell/tests/cases/compat");
  const plain = new Set([
    "name",
    "stdin",
    "ignore_stderr",
    "known_failure",
    "min_oracle_version",
    "timeout_in_seconds",
  ]);
  const cases: CompatCase[] = [];
  const files = (await readdir(directory, { recursive: true }))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const { parse } = await import("yaml");
  for (const file of files) {
    const suite = parseBrushSuite(
      parse(await corpusText("brush-suite", file, resolve(directory, file))),
    );
    for (const [index, entry] of suite.cases.entries()) {
      const extra = Object.keys(entry).filter((key) => !plain.has(key));
      cases.push({
        corpus: "brush-suite",
        file: file.replace(/\.yaml$/, ""),
        line: index + 1,
        name: typeof entry.name === "string" ? entry.name : `case ${index + 1}`,
        code: typeof entry.stdin === "string" ? entry.stdin : "",
        excluded:
          !entry.stdin || suite.commonTestFiles || extra.length
            ? "needs Brush harness arguments, files, environment, terminal or a skip marker"
            : undefined,
      });
    }
  }
  return cases;
}

// Secondary signal: Bashkit's own bash spec cases, parsed like its spec_runner.rs.
// Files ported from Oils or just-bash are left out: they duplicate other corpora.
function parseBashkitCases(file: string, lines: readonly string[]): CompatCase[] {
  const cases: CompatCase[] = [];
  let current: CompatCase | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("### ")) {
      const directive = line.slice(4).trim();
      if (directive === "expect" || directive === "end") current = undefined;
      else if (!/^(exit_code|skip|bash_diff|paused_time)\b/.test(directive)) {
        current = {
          corpus: "bashkit-suite",
          file: basename(file, ".test.sh"),
          line: index + 1,
          name: directive,
          code: "",
        };
        cases.push(current);
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith("# ") && !current.code && !current.described) {
      current.described = true;
      continue;
    }
    current.code += line + "\n";
  }
  return cases;
}

async function loadBashkitCases(): Promise<CompatCase[]> {
  if (!corpusNames.includes("bashkit-suite")) return [];
  const directory = resolve(bashkitCorpus, "crates/bashkit/tests/spec_cases/bash");
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".test.sh"))
    .filter((name) => !name.startsWith("oils-") && !name.includes("just-bash"))
    .sort();
  const cases: CompatCase[] = [];
  for (const file of files) {
    const lines = (await corpusText("bashkit-suite", file, resolve(directory, file))).split("\n");
    cases.push(...parseBashkitCases(file, lines));
  }
  for (const item of cases) delete item.described;
  return cases.filter((item) => item.code.trim());
}

// Port of the tokenizer in Oils test/sh_spec.py: comment lines are dropped from code,
// blank lines are kept once code has started, and `## key: value` lines end the code.
function parseSpecFile(text: string): ParsedCase[] {
  const keyValue = /^##\s+(?:(?:OK(?:-\d)?|BUG(?:-\d)?|N-I)\s+[\w+/]+\s+)?([\w-]+):\s*(.*)$/;
  const lines = text.split(/(?<=\n)/);
  const cases: ParsedCase[] = [];
  let current: ParsedCase | undefined;
  let state = "header";
  let resume = "after-code";
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("####")) {
      current = { name: line.slice(4).trim(), line: index + 1, code: "" };
      cases.push(current);
      state = "before-code";
      continue;
    }
    if (state === "header") continue;
    if (state === "multiline") {
      if (/^##\s+END/.test(line)) state = resume;
      continue;
    }
    if (!current) throw new Error("Spec case content has no case header");
    const metadata = keyValue.exec(line);
    if (metadata) {
      // Metadata may precede the code; metadata after code ends it.
      resume = state === "before-code" && metadata[1] !== "code" ? "before-code" : "after-code";
      if (metadata[1] === "code") current.code = metadata[2] + "\n";
      state = metadata[1] === "STDOUT" || metadata[1] === "STDERR" ? "multiline" : resume;
      continue;
    }
    if (/^##\s+END/.test(line) || line.trimStart().startsWith("#")) continue;
    if (state === "before-code" && !line.trim()) continue;
    if (state === "after-code") continue;
    state = "code";
    current.code += line.endsWith("\n") ? line : line + "\n";
  }
  return cases.filter((item) => item.code);
}

function normalizeResult<T extends BufferedResult>(actual: T): T {
  return normalize(actual, [
    [virtualTmp, "$TMP"],
    [virtualHome, "$HOME"],
  ]);
}

function same(
  expected: Pick<BufferedResult, "status" | "stdout">,
  actual: Pick<BufferedResult, "status" | "stdout">,
) {
  return expected.status === actual.status && expected.stdout.equals(actual.stdout);
}

function judge(item: CompatCase, raw: PoolResult, available: ReadonlySet<string>): JudgedResult {
  const actual = normalizeResult(raw);
  if (!item.bash) throw new Error(`Missing Bash result for ${caseId(item)}`);
  if (!actual.timeout && !actual.crash && same(item.bash, actual))
    return {
      outcome: "pass",
      stderrAgrees: !item.bash.stderr.length === !actual.stderr.length,
    };
  const missing = (item.needs ?? []).filter((name) => !available.has(name));
  let outcome: Outcome = "fail";
  if (actual.timeout) outcome = "timeout";
  else if (actual.crash) outcome = "crash";
  else if (missing.length) outcome = "missing-command";
  return {
    outcome,
    missing: missing.length ? missing : undefined,
    status: actual.status,
    stdout: clip(actual.stdout),
    stderr: clip(actual.stderr),
    crash: actual.crash,
  };
}

function clip(bytes: Buffer, limit = 240) {
  const text = bytes.toString("utf8");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid compatibility worker ${key}`);
  return value;
}

function parseWorkerResult(value: unknown, id: number): PoolResult | null {
  if (!isRecord(value) || value.id !== id) return null;
  if (!(value.stdout instanceof Uint8Array) || !(value.stderr instanceof Uint8Array))
    throw new Error("Invalid compatibility worker output");
  if (value.status !== undefined && typeof value.status !== "number")
    throw new Error("Invalid compatibility worker status");
  if (value.crash !== undefined && typeof value.crash !== "string")
    throw new Error("Invalid compatibility worker crash");
  return {
    stdout: Buffer.from(value.stdout),
    stderr: Buffer.from(value.stderr),
    status: value.status,
    crash: value.crash,
    timeout: optionalBoolean(value, "timeout"),
    outputLimit: optionalBoolean(value, "outputLimit"),
    cancelled: optionalBoolean(value, "cancelled"),
    dead: optionalBoolean(value, "dead"),
  };
}

class Pool {
  private readonly engine: EngineName;
  private idle: Worker[] = [];
  private readonly waiting: ((worker: Worker | null) => void)[] = [];
  private readonly workers = new Set<Worker>();
  private readonly size: number;
  private sequence = 0;
  private closed = cancelled;
  private closing: Promise<void> = Promise.resolve();

  constructor(engine: EngineName, size: number) {
    this.engine = engine;
    this.size = size;
  }

  async spawn(): Promise<Worker | null> {
    if (this.closed) return null;
    const worker = new Worker(resolve(import.meta.dirname, "bash-compat-worker.ts"), {
      workerData: {
        engine: this.engine,
        modulePath: engines[this.engine].modulePath,
        scratch,
        fixtureDirectory: resolve(
          root,
          process.env.BASH_COMPAT_FIXTURE_DIR ??
            `${process.env.CARGO_TARGET_DIR ?? ".build/shell"}/wasm32-wasip1/release`,
        ),
        utilityDirectory: process.env.BASH_COMPAT_UTILITY_DIR
          ? resolve(root, process.env.BASH_COMPAT_UTILITY_DIR)
          : undefined,
        programs: compatibilityPrograms,
        tmp: virtualTmp,
        home: virtualHome,
        env: { HOME: virtualHome, TMP: virtualTmp, SH: "bash", LC_ALL: "C.UTF-8" },
      },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    this.workers.add(worker);
    await new Promise<void>((ready, fail) => {
      const onReady = () => {
        worker.off("error", fail);
        worker.off("exit", onExit);
        ready();
      };
      const onExit = (code: number) => fail(new Error(`worker exited before ready: ${code}`));
      worker.once("message", onReady);
      worker.once("error", fail);
      worker.once("exit", onExit);
    });
    if (this.closed) {
      await worker.terminate();
      return null;
    }
    return worker;
  }

  async acquire(): Promise<Worker | null> {
    if (this.closed) return null;
    if (this.idle.length) return this.idle.pop() ?? null;
    if (this.workers.size < this.size) return this.spawn();
    return new Promise((resume) => {
      if (this.closed) resume(null);
      else this.waiting.push(resume);
    });
  }

  release(worker: Worker) {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  async replace(worker: Worker) {
    this.workers.delete(worker);
    await worker.terminate();
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) next(await this.spawn());
  }

  async run(code: string): Promise<PoolResult> {
    const worker = await this.acquire();
    if (!worker)
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cancelled: true, dead: true };
    const id = ++this.sequence;
    const result = await new Promise<PoolResult>((done) => {
      const finish = (value: PoolResult) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        done(value);
      };
      const empty = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const onMessage = (message: unknown) => {
        const value = parseWorkerResult(message, id);
        if (value) finish(value);
      };
      const onError = (error: unknown) => finish({ ...empty, crash: String(error), dead: true });
      const onExit = (code: number) =>
        finish({ ...empty, crash: `worker exited ${code}`, dead: true });
      const timer = setTimeout(() => finish({ ...empty, timeout: true, dead: true }), timeoutMs);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage({ id, code });
    });
    if (result.dead) await this.replace(worker);
    else this.release(worker);
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return this.closing;
    this.closed = true;
    for (const resume of this.waiting.splice(0)) resume(null);
    const workers = Array.from(this.workers);
    this.workers.clear();
    this.idle = [];
    this.closing = Promise.all(workers.map((worker) => worker.terminate())).then(() => undefined);
    return this.closing;
  }
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  let stopped = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stopped && !cancelled && next < items.length) {
      const index = next++;
      try {
        await task(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  const results = await Promise.allSettled(lanes);
  if (cancelled) return;
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

function rate(passed: number, total: number) {
  return total ? Math.round((1000 * passed) / total) / 10 : null;
}

interface EvidenceInput {
  bashVersion: string;
  cases: CompatCase[];
  spots: SpotCheck[];
  inventories: Record<EngineName, string[]>;
  inventoryNames: string[];
}

function buildEvidence({ bashVersion, cases, spots, inventories, inventoryNames }: EvidenceInput) {
  const scored = cases.filter((item) => !item.excluded);
  const builtins = scored.filter((item) => item.kind === "builtins-only");
  const summarize = (items: CompatCase[]) =>
    Object.fromEntries(
      engineNames.map((engine) => {
        const outcomes: Record<string, number> = {};
        for (const item of items) {
          const result = item.results?.[engine];
          if (!result) throw new Error(`Missing ${engine} result for ${caseId(item)}`);
          const outcome = result.outcome;
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        }
        return [
          engine,
          { cases: items.length, passRate: rate(outcomes.pass ?? 0, items.length), outcomes },
        ];
      }),
    );
  const count = (items: CompatCase[]) => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      if (!item.excluded) continue;
      counts[item.excluded] = (counts[item.excluded] ?? 0) + 1;
    }
    return counts;
  };
  const oils = builtins.filter((item) => item.corpus === "oils");
  const corpora = Object.fromEntries(
    corpusNames.map((name) => {
      const all = cases.filter((item) => item.corpus === name);
      const kept = scored.filter((item) => item.corpus === name);
      return [
        name,
        {
          cases: all.length,
          exclusions: count(all.filter((item) => item.excluded)),
          builtinsOnly: summarize(builtins.filter((item) => item.corpus === name)),
          needsCommands: summarize(kept.filter((item) => item.kind === "needs-commands")),
        },
      ];
    }),
  );
  return {
    question: "How closely does each browser shell interpreter match GNU bash?",
    method: [
      "Each case runs once per engine in a fresh shell with empty stdin and a per-case timeout.",
      "bash -c runs each case twice with the full PATH and once with only the two test helpers on PATH.",
      "A case is builtins-only when bash gives identical stdout and status in both PATH modes. Only those cases form the interpreter score.",
      "Other cases need external commands (or spawn $SH). A failure there is missing-command when the engine lacks a command bash needed.",
      "Pass means identical stdout bytes and exit status after replacing each engine's $TMP and $HOME paths. stderr is recorded but not scored.",
    ],
    oracle: bashVersion,
    node: process.version,
    timeoutMs,
    sources: {
      oils: { repository: pins.oils.repository, revision: pins.oils.revision },
      "brush-suite": `vendor/brush ${pins.brush.revision} brush-shell/tests/cases/compat`,
      "bashkit-suite": `Bashkit ${pins.bashkitTerminal.revision} crates/bashkit/tests/spec_cases/bash, without oils-* and just-bash ports`,
    },
    oilsFiles: categories,
    oilsExcludedFiles: excludedFiles,
    engines: {
      "own-shell":
        "Production shell-runtime guest, wasm32-wasip1, on Waffle's Node runtime with fixture guests; no browser terminal",
    },
    corpora,
    oilsByCategory: Object.fromEntries(
      Object.keys(categories).map((category) => [
        category,
        summarize(oils.filter((item) => item.category === category)),
      ]),
    ),
    oilsPassesByFile: Object.fromEntries(
      Array.from(new Set(oils.map((item) => item.file)), (file) => {
        const items = oils.filter((item) => item.file === file);
        return [
          file,
          Object.fromEntries(
            [["cases", items.length]].concat(
              engineNames.map((engine) => [
                engine,
                items.filter((item) => judgedFor(item, engine).outcome === "pass").length,
              ]),
            ),
          ),
        ];
      }),
    ),
    stderrAgreementOnOilsPasses: Object.fromEntries(
      engineNames.map((engine) => {
        const passes = oils.filter((item) => judgedFor(item, engine).outcome === "pass");
        return [
          engine,
          rate(passes.filter((item) => judgedFor(item, engine).stderrAgrees).length, passes.length),
        ];
      }),
    ),
    commandInventory: Object.fromEntries(
      engineNames.map((engine) => [engine, inventories[engine]]),
    ),
    inventoryProbe: inventoryNames,
    spotChecks: spots.map((spot) => ({ name: spot.name, code: spot.code, results: spot.results })),
    // Oils cases keep clipped output for every failure. Secondary corpora keep outcomes only.
    cases: cases.map((item) => {
      const detailed = item.corpus === "oils";
      const bash = item.bash;
      return {
        corpus: item.corpus,
        file: item.file,
        line: item.line,
        name: item.name,
        kind: item.excluded ? undefined : item.kind,
        excluded: item.excluded,
        needs: item.needs?.length ? item.needs : undefined,
        bash:
          detailed &&
          bash &&
          item.results &&
          Object.values(item.results).some((value) => value.outcome !== "pass")
            ? { status: bash.status, stdout: clip(bash.stdout) }
            : undefined,
        results: item.results
          ? Object.fromEntries(
              Object.entries(item.results).map(([engine, value]) => [
                engine,
                evidenceResult(value, detailed),
              ]),
            )
          : undefined,
      };
    }),
  };
}

function renderSummary(evidence: ReturnType<typeof buildEvidence>) {
  const header = `| Category | Cases | ${engineNames.join(" | ")} |`;
  const divider = `| --- | ---: | ${engineNames.map(() => "---:").join(" | ")} |`;
  const row = (
    label: string,
    summary: ReturnType<typeof buildEvidence>["oilsByCategory"][string],
  ) => {
    const first = summary[engineNames[0]];
    return `| ${label} | ${first.cases} | ${engineNames
      .map((engine) => (summary[engine].passRate === null ? "-" : `${summary[engine].passRate}%`))
      .join(" | ")} |`;
  };
  const rows = Object.entries(evidence.oilsByCategory).map(([category, summary]) =>
    row(category, summary),
  );
  const corpusRows = Object.entries(evidence.corpora).flatMap(([name, corpus]) => [
    row(`**${name}: builtins-only**`, corpus.builtinsOnly),
    row(`${name}: needs external commands`, corpus.needsCommands),
  ]);
  return [header, divider].concat(rows, corpusRows).join("\n");
}

function log(message: string) {
  console.error(`[bash-compat] ${message}`);
}

async function corpusText(corpus: Corpus, file: string, path: string) {
  const bytes = await readFile(path);
  (sourceFiles[corpus] ??= {})[file] = bytesDigest(bytes);
  return bytes.toString("utf8");
}
function caseId(item: { corpus: string; file: string; line?: number }) {
  return `${item.corpus}:${item.file}:${item.line}`;
}

function judgedFor(item: CompatCase, engine: EngineName): JudgedResult {
  const result = item.results?.[engine];
  if (!result) throw new Error(`Missing ${engine} result for ${caseId(item)}`);
  return result;
}

function evidenceResult(value: JudgedResult, detailed: boolean) {
  if (value.outcome === "pass") return "pass";
  if (detailed) return value;
  if (value.crash) return { outcome: value.outcome, crash: value.crash };
  return value.outcome;
}
const packResult = (result: ShellResult): PackedResult => ({
  status: result.status,
  stdout: result.stdout.toString("base64"),
  stderr: result.stderr.toString("base64"),
  ...(result.timeout ? { timeout: true } : {}),
  ...(result.outputLimit ? { outputLimit: true } : {}),
  ...(result.crash ? { crash: result.crash } : {}),
});
function runtimeEnvironment() {
  return {
    target: "wasm32-wasip1",
    runner: "waffle-node",
    nodeVersion: "v26.12.1",
    shell: "shell-runtime -c SCRIPT, the production runtime_proc guest",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: virtualHome,
      TMP: virtualTmp,
      PWD: virtualTmp,
      SH: "bash",
      LC_ALL: "C.UTF-8",
    },
    stdin: "empty",
    filesystem:
      "fresh Waffle filesystem per case, no persistence: working directory, /dev, /bin, /usr/bin, /usr/local/bin",
    processHost: "Waffle process broker; argv.py and printenv.py fixture guests only",
    timeoutMs,
    outputLimitBytes: 4 * 1024 * 1024,
    normalization: [
      [virtualTmp, "$TMP"],
      [virtualHome, "$HOME"],
    ],
    scoring: "stdout bytes and exit status; stderr retained separately, not scored",
  };
}
async function captureOracle(cases: CompatCase[], helperDirectory: string, bashVersion: string) {
  if (process.version !== runtimeEnvironment().nodeVersion)
    throw new Error(`Capture requires ${runtimeEnvironment().nodeVersion}, got ${process.version}`);
  if (!bashVersion.startsWith("GNU bash, version 5.3.15(1)-release"))
    throw new Error(`Expected GNU bash 5.3.15(1)-release, got ${bashVersion}`);
  const previous: unknown = JSON.parse(
    await readFile(resolve(root, "docs/evidence/bash-compatibility.json"), "utf8"),
  );
  const classified = new Map(parseClassification(previous).map((item) => [caseId(item), item]));
  if (classified.size !== cases.length)
    throw new Error("Pinned corpus case count differs from published classification");
  let done = 0;
  const records: CaptureRecord[] = await Promise.all(
    cases.map(async (item) => {
      const old = classified.get(caseId(item));
      if (
        !old ||
        item.line === undefined ||
        old.name !== item.name ||
        Boolean(old.excluded?.startsWith("needs Brush")) !==
          Boolean(item.excluded?.startsWith("needs Brush"))
      )
        throw new Error(`Pinned corpus case differs: ${caseId(item)}`);
      return {
        id: caseId(item),
        corpus: item.corpus,
        file: item.file,
        line: item.line,
        name: item.name,
        category: item.category ?? item.file,
        code: item.code,
        ...(old.kind ? { kind: old.kind } : {}),
        ...(old.excluded ? { excluded: old.excluded } : {}),
        ...(old.needs ? { needs: old.needs } : {}),
      };
    }),
  );
  const path = `${helperDirectory}:/usr/local/bin:/usr/bin:/bin`;
  if (cancelled) return;
  const preflight = await runShell(bashPath, "printf compat-oracle-ready", path, true);
  if (cancelled) return;
  if (preflight.status !== 0 || preflight.stdout.toString() !== "compat-oracle-ready")
    throw new Error(`Oracle sandbox preflight failed: ${preflight.stderr.toString()}`);
  await mapLimit(records, jobs, async (item) => {
    if (cancelled || item.excluded || item.kind !== "builtins-only") return;
    const first = await runShell(bashPath, item.code, path, true);
    if (cancelled) return;
    const second = await runShell(bashPath, item.code, path, true);
    if (cancelled) return;
    item.bash = packResult(first);
    if (first.outputLimit || second.outputLimit)
      item.excluded = "fresh bash oracle exceeded 4 MiB output limit";
    else if (first.timeout || second.timeout) item.excluded = "fresh bash oracle timed out";
    else if (!same(first, second)) item.excluded = "fresh bash oracle output is not deterministic";
    if (++done % 250 === 0) log(`fresh bash oracle: ${done}`);
  });
  if (cancelled) return;
  const oracle = validatedOracle(
    sealOracle({
      schema: 1,
      oracle: {
        version: bashVersion,
        executableSha256: bytesDigest(await readFile(bashPath)),
        captureNode: process.version,
        stdoutTransport: bashStdoutTransport,
        stderrTransport: bashStderrTransport,
        capturePlatform: process.platform,
        captureArch: process.arch,
        sandbox:
          "bubblewrap unshare-all; /usr read-only; private case home/tmp; no network or owner files",
        classification:
          "Published docs/evidence/bash-compatibility.json builtins-only membership, fresh observations; external and excluded cases retained as skips",
        classificationSha256: bytesDigest(
          await readFile(resolve(root, "docs/evidence/bash-compatibility.json")),
        ),
        helpersSha256: bytesDigest(await readFile(resolve(root, "scripts/bash-compat-helpers.ts"))),
      },
      environment: runtimeEnvironment(),
      sources: {
        oils: { ...pins.oils, files: sourceFiles.oils },
        "brush-suite": { revision: pins.brush.revision, files: sourceFiles["brush-suite"] },
        "bashkit-suite": {
          revision: pins.bashkitTerminal.revision,
          files: sourceFiles["bashkit-suite"],
        },
      },
      cases: records,
    }),
  );
  await writeRows(oracleFile, oracle);
  log(`wrote fresh oracle ${oracleFile}`);
  console.log(
    JSON.stringify(
      summarize({
        cases: records.map((item) => ({
          ...item,
          outcome: item.excluded || item.kind !== "builtins-only" ? "skip" : "fail",
        })),
      }),
      null,
      2,
    ),
  );
}
async function writeRows<T extends { cases: unknown[] }>(path: string, value: T) {
  const rows = value.cases.map((item) => JSON.stringify(item)).join(",\n");
  await writeFile(
    path,
    JSON.stringify({ ...value, cases: "CASES" }, null, 2).replace(
      '"CASES"',
      () => `[\n${rows}\n]`,
    ) + "\n",
  );
}
async function runFrozen() {
  const oracle = validatedOracle(JSON.parse(await readFile(oracleFile, "utf8")));
  if (pins.shellScoreboard?.oracleSha256 !== bytesDigest(await readFile(oracleFile)))
    throw new Error("Fixed oracle checksum differs from sources.lock.json");
  if (
    oracle.sources.oils.revision !== pins.oils.revision ||
    oracle.sources["brush-suite"].revision !== pins.brush.revision ||
    oracle.sources["bashkit-suite"].revision !== pins.bashkitTerminal.revision
  )
    throw new Error("Fixed oracle source pins changed; recapture base and candidate together");
  if (
    digest(oracle.environment) !== digest(runtimeEnvironment()) ||
    process.version !== oracle.environment.nodeVersion
  )
    throw new Error("incomparable runtime environment");
  const baselines: { label: string; score: unknown }[] = [];
  if (process.env.BASH_COMPAT_RECORD !== "1" && process.env.BASH_COMPAT_RAW !== "1") {
    const committed: unknown = JSON.parse(await readFile(baselineFile, "utf8"));
    baselines.push({ label: "committed baseline", score: committed });
    if (cancelled) return;
    let target: unknown;
    try {
      target = await targetBranchBaseline(root, process.env.BASH_COMPAT_BASE_REF, oracle);
    } catch (error) {
      if (cancelled) return;
      throw error;
    }
    if (cancelled) return;
    if (target) baselines.push({ label: "target branch baseline", score: target });
  }
  const validatedBaselines = baselines.map((baseline) => ({
    label: baseline.label,
    score: validatedScore(oracle, baseline.score),
  }));
  if (cancelled) return;
  prepareEngines();
  const pool = new Pool("own-shell", jobs);
  pools.push(pool);
  const cases: ScoreCase[] = oracle.cases.map((item) => ({
    id: item.id,
    corpus: item.corpus,
    category: item.category,
    kind: item.kind,
    outcome: "skip",
    ...(item.excluded ? { excluded: item.excluded } : {}),
  }));
  let done = 0;
  await mapLimit(oracle.cases, jobs, async (item, index) => {
    if (cancelled || item.excluded || item.kind !== "builtins-only") return;
    const actual = normalizeResult(await pool.run(item.code));
    if (cancelled) return;
    const expected = { status: item.bash.status, stdout: Buffer.from(item.bash.stdout, "base64") };
    let outcome = "fail";
    if (actual.timeout) outcome = "timeout";
    else if (actual.crash) outcome = "crash";
    else if (same(expected, actual)) outcome = "pass";
    cases[index] = {
      ...cases[index],
      outcome,
      ...(outcome === "pass" ? {} : { actual: compactResult(actual) }),
    };
    if (++done % 250 === 0) log(`own-shell: ${done}`);
  });
  await pool.close();
  if (cancelled) return;
  const score: Score = {
    identity: oracle.identity,
    engine: "own-shell",
    counts: summarize({ cases }),
    cases,
  };
  validateScore(oracle, score);
  console.log(JSON.stringify({ identity: score.identity, counts: summarize(score) }, null, 2));
  if (process.env.BASH_COMPAT_OUT) await writeRows(output, score);
  let passed = true;
  for (const baseline of validatedBaselines) {
    const delta: unknown = compareScores(baseline.score, score);
    if (!isRecord(delta) || typeof delta.ok !== "boolean")
      throw new Error("Invalid score comparison");
    console.log(JSON.stringify({ baseline: baseline.label, ...delta }, null, 2));
    passed &&= delta.ok;
  }
  if (!passed)
    throw new Error("own-shell corpus regression; see gained/lost/newlyFailing cases above");
}

async function cleanup() {
  cancelled = true;
  killAll();
  await shutdown;
  await Promise.allSettled(activeChildren.values());
  for (const pool of pools) await pool.close();
  if (activeChildren.size)
    throw new Error(`compatibility consumers remain; scratch retained at ${scratch}`);
  await rm(scratch, { recursive: true, force: true });
}

try {
  await main();
} finally {
  await cleanup();
}
