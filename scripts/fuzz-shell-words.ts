#!/usr/bin/env node
// Deterministic differential fuzzer for quote and parameter-word boundaries.
// The native shell binary is intentionally used here: this lane is about parser,
// lexer, and lazy-reparse behavior, not the browser/WASI adapter.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Options = {
  count: number;
  seed: number;
  timeoutMs: number;
  shell?: string;
  replays: string[];
  output?: string;
  record?: string;
};
type Random = {
  next(): number;
  pick<T>(items: readonly T[]): T;
  chance(numerator: number, denominator?: number): boolean;
};
type Expression = { source: string; tags: string[] };
type WordCase = {
  id: string;
  operator: string;
  quote: string;
  valueState: string;
  operandState: string;
  expression: Expression;
  featureTags: string[];
  label?: string;
  value?: string;
  operandValue?: string;
  expectedUnsupported?: boolean;
  fixedScript?: string;
};
type CaseIdentity = ReturnType<typeof caseIdentity>;
type Coverage = ReturnType<typeof coverage>;
type WordResult = {
  status: number | null;
  signal?: string;
  timedOut?: boolean;
  stdout: Buffer;
  stderr: Buffer;
};
type EncodedWordResult = {
  status: number | null;
  signal?: string;
  timedOut?: boolean;
  stdoutBase64: string;
  stderrBase64: string;
};
type RecordedWordCase = { case: CaseIdentity; script: string; bash: EncodedWordResult };
type Fixture = {
  schema: number;
  sourceHash: string;
  seed: number;
  count: number;
  timeoutMs: number;
  bash: string;
  operators: string[];
  coverage: Coverage;
  cases: RecordedWordCase[];
};
type Classification = "MATCH" | "UNSUPPORTED" | "MISMATCH";
type Counts = Record<Classification, number>;
type Execution = {
  script: string;
  bash: WordResult;
  ours: WordResult;
  classification: Classification;
};
type ResultView = ReturnType<typeof resultView>;
type MismatchView = {
  id: string;
  operator: string;
  quote: string;
  featureTags?: string[];
  script: string;
  bash: ResultView;
  ours: ResultView;
};

const root = resolve(import.meta.dirname, "..");
const queue = "/work/tmp/wave-heavy/run.sh";
const operators = [
  ":-",
  "-",
  ":=",
  "=",
  ":+",
  "+",
  ":?",
  "/",
  "//",
  "/#",
  "/%",
  "#",
  "##",
  "%",
  "%%",
  "^",
  "^^",
  ",",
  ",,",
  "!",
  "#name",
];
const knownUnsupportedOperators = new Set();
const operatorGroups = new Map([
  [":-", "default"],
  ["-", "default"],
  [":=", "assignment"],
  ["=", "assignment"],
  [":+", "alternative"],
  ["+", "alternative"],
  [":?", "error"],
  ["/", "replacement"],
  ["//", "replacement"],
  ["/#", "replacement"],
  ["/%", "replacement"],
  ["#", "trim-prefix"],
  ["##", "trim-prefix"],
  ["%", "trim-suffix"],
  ["%%", "trim-suffix"],
  ["^", "case"],
  ["^^", "case"],
  [",", "case"],
  [",,", "case"],
  ["!", "indirection"],
  ["#name", "length"],
]);

function usage() {
  console.log(`Usage: npm run fuzz:shell-words -- [options]

Options:
  --count N       Generated cases, excluding fixed regressions (default: 3000)
  --seed N        Unsigned deterministic seed (default: 1)
  --timeout-ms N  Timeout for each Bash and shell process (default: 2000)
  --shell PATH    Existing native shell-engine binary
  --output PATH   Write the same JSON report printed to stdout
  --record PATH  Record Bash 5.3.15 output and require a clean native run
  --replay PATH  Replay a recorded fixture without invoking Bash (repeatable)
  --help          Show this help

If --shell is omitted, shell-engine is built in a temporary target directory through
/work/tmp/wave-heavy/run.sh and removed when this command exits.`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    count: 3000,
    seed: 1,
    timeoutMs: 2000,
    shell: process.env.FUZZ_SHELL_BIN,
    replays: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--queue-active") continue;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    const [name, inline] = arg.split("=", 2);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--count") options.count = Number.parseInt(value, 10);
    else if (name === "--seed") options.seed = Number(value) >>> 0;
    else if (name === "--timeout-ms") options.timeoutMs = Number.parseInt(value, 10);
    else if (name === "--shell") options.shell = resolve(value);
    else if (name === "--output") options.output = resolve(value);
    else if (name === "--record") options.record = resolve(value);
    else if (name === "--replay") options.replays.push(resolve(value));
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isSafeInteger(options.count) || options.count < 0)
    throw new Error("--count must be a non-negative integer");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error("--timeout-ms must be a positive integer");
  return options;
}

function rng(seed: number): Random {
  let state = seed >>> 0;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    },
    pick<T>(items: readonly T[]): T {
      return items[this.next() % items.length];
    },
    chance(numerator: number, denominator = 2) {
      return this.next() % denominator < numerator;
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const atomPool = [
  { source: "x", tags: ["literal"] },
  { source: "following", tags: ["literal", "following-word"] },
  { source: "'single'", tags: ["single-quoted"] },
  { source: '"double"', tags: ["double-quoted"] },
  { source: '"don\'t"', tags: ["double-quoted", "apostrophe"] },
  { source: "'$('", tags: ["single-quoted", "raw-dollar-paren"] },
  { source: "'${'", tags: ["single-quoted", "raw-dollar-brace"] },
  { source: "'`'", tags: ["single-quoted", "raw-backtick"] },
  { source: "\\ ", tags: ["backslash", "space"] },
  { source: "\\{", tags: ["backslash", "brace"] },
  { source: "\\}", tags: ["backslash", "brace"] },
  { source: "'{'", tags: ["single-quoted", "brace"] },
  { source: "'}'", tags: ["single-quoted", "brace"] },
  { source: "'/'", tags: ["single-quoted", "slash"] },
  { source: "'*'", tags: ["single-quoted", "star"] },
  { source: "'?'", tags: ["single-quoted", "question"] },
  { source: "'[a-z]'", tags: ["single-quoted", "bracket"] },
  { source: "''", tags: ["single-quoted", "empty"] },
  { source: '""', tags: ["double-quoted", "empty"] },
  { source: "'a b'", tags: ["single-quoted", "space"] },
  { source: '"a b"', tags: ["double-quoted", "space"] },
  { source: "a", tags: ["literal"] },
  { source: "b", tags: ["literal"] },
];
const patternPool = atomPool.filter(
  ({ tags }) => !tags.includes("space") || tags.includes("single-quoted"),
);
const states = ["unset", "empty", "value"];
const values = ["b", "abc", "a b", "don't", "'", "${", "$(", "a/b", "a*?", "foo"];

function combineTags(...parts: (Expression | readonly string[])[]): string[] {
  return Array.from(
    new Set(parts.flatMap((part) => ("tags" in part ? part.tags : part))),
  ).toSorted();
}

function buildOperand(random: Random, depth: number): Expression {
  if (depth > 0 && random.chance(2, 5)) {
    const nestedTarget = random.chance(1, 2) ? "u" : "v";
    const nested = expressionFor(random.pick(operators), random, depth - 1, nestedTarget);
    const quoted = !nested.source.includes('"') && random.chance(1, 3);
    return {
      source: quoted ? `"${nested.source}"` : nested.source,
      tags: combineTags(nested, ["nested-" + depth].concat(quoted ? ["nested-double-quoted"] : [])),
    };
  }
  const atom = random.pick(atomPool);
  return { source: atom.source, tags: atom.tags };
}

function buildPattern(random: Random, depth: number): Expression {
  if (depth > 0 && random.chance(1, 5)) return buildOperand(random, depth);
  return random.pick(patternPool);
}

function expressionFor(operator: string, random: Random, depth: number, target = "v"): Expression {
  if (operator === "!") return { source: "${!pointer}", tags: ["indirection"] };
  if (operator === "#name") return { source: `\${#${target}}`, tags: ["length"] };
  if (operator === "^" || operator === "^^" || operator === "," || operator === ",,") {
    const pattern = random.chance(1, 2)
      ? buildPattern(random, depth)
      : { source: "", tags: ["empty"] };
    return {
      source: `\${${target}${operator}${pattern.source}}`,
      tags: combineTags(pattern, ["case"]),
    };
  }
  if (operator === "/" || operator === "//" || operator === "/#" || operator === "/%") {
    const pattern = buildPattern(random, depth);
    const replacement = buildOperand(random, depth);
    return {
      source: `\${${target}${operator}${pattern.source}/${replacement.source}}`,
      tags: combineTags(pattern, replacement, ["replacement"]),
    };
  }
  const operand = buildOperand(random, depth);
  const group = operatorGroups.get(operator);
  if (group === undefined) throw new Error("unknown operator " + operator);
  return {
    source: `\${${target}${operator}${operand.source}}`,
    tags: combineTags(operand, [group]),
  };
}

function stateAssignment(name: string, state: string, value?: string): string {
  if (state === "unset") return `unset ${name}`;
  if (state === "empty") return `${name}=''`;
  return `${name}=${shellQuote(value ?? "")}`;
}

function renderCase(testCase: WordCase): string {
  if (testCase.fixedScript) return testCase.fixedScript;
  const assignments = [
    "unset v u pointer",
    stateAssignment("v", testCase.valueState, testCase.value),
    stateAssignment("u", testCase.operandState, testCase.operandValue),
    "pointer=v",
  ];
  const printed =
    testCase.quote === "double" ? `"${testCase.expression.source}"` : testCase.expression.source;
  // Repeating %s consumes every post-expansion field, preserving boundaries.
  return `${assignments.join("; ")}; printf '<%s>\\n' ${printed} following`;
}

function generatedCase(random: Random, index: number, requestedQuote?: string): WordCase {
  const operator = operators[index % operators.length];
  const expression = expressionFor(operator, random, random.next() % 4);
  const valueState = random.pick(states);
  const operandState = random.pick(states);
  const quote = requestedQuote ?? (random.chance(1, 2) ? "double" : "top-level");
  return {
    id: `generated-${index}-${quote}`,
    operator,
    quote,
    valueState,
    operandState,
    value: random.pick(values),
    operandValue: random.pick(values),
    expression,
    featureTags: combineTags(expression, [operator, quote, testCaseQuoteTag(expression)]),
  };
}

function testCaseQuoteTag(expression: Expression): string {
  return expression.tags?.includes("double-quoted") ? "inner-double-quote" : "word";
}

function fixedCases(): WordCase[] {
  const expressions: {
    label: string;
    operator: string;
    source: string;
    tags: string[];
    valueState?: string;
    expectedUnsupported?: boolean;
  }[] = [
    {
      label: "nested-default-dont",
      operator: "/",
      source: '${v/b/${u:-"don\'t"}}',
      tags: ["replacement", "nested-1", "double-quoted", "apostrophe"],
    },
    {
      label: "nested-default-single-quote",
      operator: "/",
      source: '${v/b/${u:-"\'"}}',
      tags: ["replacement", "nested-1", "double-quoted", "single-quote-content"],
    },
    {
      label: "raw-single-dollar-paren",
      operator: "/",
      source: "${v/b/'$('}",
      tags: ["replacement", "single-quoted", "raw-dollar-paren"],
    },
    {
      label: "raw-single-dollar-brace",
      operator: "/",
      source: "${v/b/'${'}",
      tags: ["replacement", "single-quoted", "raw-dollar-brace"],
    },
    {
      label: "bare-left-brace",
      operator: "/",
      source: "${v/b/{}",
      tags: ["replacement", "brace"],
    },
    {
      label: "bare-right-brace",
      operator: "/",
      source: "${v/b/}}",
      tags: ["replacement", "brace"],
    },
    {
      label: "double-apostrophe-following",
      operator: "/",
      source: '${v/b/"don\'t"following}',
      tags: ["replacement", "double-quoted", "apostrophe", "following-word"],
    },
  ];
  return expressions.flatMap((entry) =>
    ["top-level", "double"].map((quote) => ({
      id: `fixed-${entry.label}-${quote}`,
      label: entry.label,
      operator: entry.operator,
      quote,
      valueState: entry.valueState ?? "value",
      operandState: "empty",
      expectedUnsupported: entry.expectedUnsupported ?? false,
      expression: { source: entry.source, tags: entry.tags },
      featureTags: combineTags(entry.tags, [quote]),
      fixedScript: `unset v u pointer; ${entry.valueState === "unset" ? "unset v" : "v='abc'"}; u=''; pointer=v; printf '<%s>\\n' ${quote === "double" ? `"${entry.source}"` : entry.source} following`,
    })),
  );
}

function generateCases(seed: number, count: number): WordCase[] {
  const random = rng(seed);
  const cases = fixedCases();
  let generated = 0;
  for (let template = 0; generated < count; template++) {
    const topLevel = generatedCase(random, template, "top-level");
    cases.push(topLevel);
    generated++;
    if (generated < count) {
      cases.push({
        ...topLevel,
        id: `generated-${template}-double`,
        quote: "double",
        featureTags: combineTags(topLevel.expression, [
          topLevel.operator,
          "double",
          testCaseQuoteTag(topLevel.expression),
        ]),
      });
      generated++;
    }
  }
  return cases;
}

function sourceHash() {
  return createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");
}

function caseIdentity(testCase: WordCase) {
  return {
    id: testCase.id,
    label: testCase.label,
    operator: testCase.operator,
    quote: testCase.quote,
    valueState: testCase.valueState,
    operandState: testCase.operandState,
    value: testCase.value,
    operandValue: testCase.operandValue,
    expectedUnsupported: testCase.expectedUnsupported ?? false,
    expression: testCase.expression,
    featureTags: testCase.featureTags,
    fixedScript: testCase.fixedScript,
  };
}

function coverage(cases: WordCase[]) {
  return {
    operators: cases
      .map((testCase) => testCase.operator)
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted(),
    quotes: cases
      .map((testCase) => testCase.quote)
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted(),
  };
}

function encodeResult(result: WordResult): EncodedWordResult {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut || undefined,
    stdoutBase64: result.stdout.toString("base64"),
    stderrBase64: result.stderr.toString("base64"),
  };
}

function decodeResult(result: EncodedWordResult): WordResult {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: Buffer.from(result.stdoutBase64 ?? "", "base64"),
    stderr: Buffer.from(result.stderrBase64 ?? "", "base64"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEncodedResult(value: unknown, index: number): EncodedWordResult {
  if (!isRecord(value)) throw new Error("invalid fixture process result at " + index);
  if (
    (typeof value.status !== "number" && value.status !== null) ||
    (value.signal !== undefined && typeof value.signal !== "string") ||
    (value.timedOut !== undefined && typeof value.timedOut !== "boolean") ||
    typeof value.stdoutBase64 !== "string" ||
    typeof value.stderrBase64 !== "string"
  )
    throw new Error("invalid fixture process result at " + index);
  return {
    status: value.status,
    signal: value.signal,
    timedOut: value.timedOut,
    stdoutBase64: value.stdoutBase64,
    stderrBase64: value.stderrBase64,
  };
}

function parseFixture(
  path: string,
  value: unknown,
  expectedCount: number,
): { fixture: Fixture; cases: WordCase[] } {
  if (!isRecord(value) || !Array.isArray(value.cases) || !Array.isArray(value.operators))
    throw new Error("invalid shell-word fixture");
  if (
    typeof value.schema !== "number" ||
    typeof value.sourceHash !== "string" ||
    typeof value.seed !== "number" ||
    typeof value.count !== "number" ||
    typeof value.timeoutMs !== "number" ||
    typeof value.bash !== "string" ||
    !value.operators.every((operator) => typeof operator === "string")
  )
    throw new Error("invalid shell-word fixture");
  if (value.count !== expectedCount)
    throw new Error(`fixture count ${value.count} does not match requested count ${expectedCount}`);
  const cases = generateCases(value.seed, value.count);
  const generatedCoverage = coverage(cases);
  if (JSON.stringify(value.coverage) !== JSON.stringify(generatedCoverage))
    throw new Error("fixture operator/quote coverage is incomplete or stale");
  if (value.cases.length !== cases.length)
    throw new Error("fixture case count does not match generated coverage");
  const rawCases: unknown[] = value.cases;
  const recorded = cases.map((testCase, index): RecordedWordCase => {
    const entry: unknown = rawCases[index];
    if (!isRecord(entry) || typeof entry.script !== "string")
      throw new Error(`fixture Bash result is missing at case ${testCase.id}`);
    if (entry.script !== renderCase(testCase))
      throw new Error(`fixture script differs at case ${testCase.id}`);
    if (JSON.stringify(entry.case) !== JSON.stringify(caseIdentity(testCase)))
      throw new Error(`fixture case identity differs at case ${testCase.id}`);
    return {
      case: caseIdentity(testCase),
      script: entry.script,
      bash: parseEncodedResult(entry.bash, index),
    };
  });
  const fixture: Fixture = {
    schema: value.schema,
    sourceHash: value.sourceHash,
    seed: value.seed,
    count: value.count,
    timeoutMs: value.timeoutMs,
    bash: value.bash,
    operators: value.operators,
    coverage: generatedCoverage,
    cases: recorded,
  };
  validateFixture(path, fixture, cases, value.seed, expectedCount);
  return { fixture, cases };
}

function validateFixture(
  fixturePath: string,
  fixture: Fixture,
  expectedCases: WordCase[],
  expectedSeed: number,
  expectedCount: number,
) {
  if (fixture.schema !== 1) throw new Error("unsupported shell-word fixture schema");
  if (fixture.sourceHash !== sourceHash())
    throw new Error("fixture source hash does not match this fuzzer");
  if (fixture.seed !== expectedSeed || fixture.count !== expectedCount)
    throw new Error("fixture seed/count does not match requested coverage");
  if (!Number.isSafeInteger(fixture.timeoutMs) || fixture.timeoutMs < 1)
    throw new Error("fixture timeout is invalid");
  const filenameSeed = /seed-(\d+)\.json$/.exec(fixturePath);
  if (filenameSeed && Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed does not match fixture seed");
  if (fixture.operators?.join("\u0000") !== operators.join("\u0000"))
    throw new Error("fixture operator list does not match this fuzzer");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== expectedCases.length)
    throw new Error("fixture case count does not match generated coverage");
  const expectedCoverage = coverage(expectedCases);
  if (JSON.stringify(fixture.coverage) !== JSON.stringify(expectedCoverage))
    throw new Error("fixture operator/quote coverage is incomplete or stale");
  for (let index = 0; index < expectedCases.length; index++) {
    const actual = fixture.cases[index];
    const expected = expectedCases[index];
    if (actual.script !== renderCase(expected))
      throw new Error(`fixture script differs at case ${expected.id}`);
    if (JSON.stringify(actual.case) !== JSON.stringify(caseIdentity(expected)))
      throw new Error(`fixture case identity differs at case ${expected.id}`);
    if (!actual.bash?.stdoutBase64 && actual.bash?.stdoutBase64 !== "")
      throw new Error(`fixture Bash result is missing at case ${expected.id}`);
  }
}

function runProcess(
  command: string,
  args: string[],
  script: string,
  timeoutMs: number,
): WordResult {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(command, args, {
    input: undefined,
    encoding: null,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  if (result.error) {
    return {
      status:
        result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT"
          ? null
          : 1,
      timedOut:
        result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? String(result.error.message)),
    };
  }
  return {
    status: result.status,
    signal: result.signal ?? undefined,
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
  };
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.equals(right);
}

function isAllowedUnsupported(testCase: WordCase, ours: WordResult, bash: WordResult): boolean {
  if (bash.status !== 0 || ours.status !== 2) return false;
  if (!/unsupported|parse|syntax/i.test(ours.stderr.toString())) return false;
  return testCase.expectedUnsupported === true || knownUnsupportedOperators.has(testCase.operator);
}

function classify(testCase: WordCase, bash: WordResult, ours: WordResult): Classification {
  if (bash.timedOut || ours.timedOut) return "MISMATCH";
  if (isAllowedUnsupported(testCase, ours, bash)) return "UNSUPPORTED";
  if (bash.status !== ours.status || !equalBytes(bash.stdout, ours.stdout)) return "MISMATCH";
  return "MATCH";
}

function resultView(result: WordResult) {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut || undefined,
    stdout: result.stdout.toString("utf8"),
    stdoutBase64: result.stdout.toString("base64"),
    stderr: result.stderr.toString("utf8").slice(0, 2000),
  };
}

function execute(
  testCase: WordCase,
  bashBin: string,
  shellBin: string,
  timeoutMs: number,
): Execution {
  const script = renderCase(testCase);
  const bash = runProcess(
    bashBin,
    ["--noprofile", "--norc", "-c", `set -f\n${script}`],
    script,
    timeoutMs,
  );
  const ours = runProcess(shellBin, ["-c", script], script, timeoutMs);
  return { script, bash, ours, classification: classify(testCase, bash, ours) };
}

function recordFixture(
  path: string,
  options: Options,
  cases: WordCase[],
  bashBin: string,
  shellBin: string,
): Fixture {
  const bash = bashVersion(bashBin);
  if (!bash.startsWith("GNU bash, version 5.3.15"))
    throw new Error(`recording requires GNU Bash 5.3.15, got ${bash}`);
  const recorded: RecordedWordCase[] = [];
  let mismatch: { testCase: WordCase; result: Execution } | null = null;
  for (const testCase of cases) {
    const result = execute(testCase, bashBin, shellBin, options.timeoutMs);
    if (result.classification !== "MATCH" && !mismatch) mismatch = { testCase, result };
    recorded.push({
      case: caseIdentity(testCase),
      script: result.script,
      bash: encodeResult(result.bash),
    });
  }
  if (mismatch)
    throw new Error(
      `cannot record a dirty fixture at ${mismatch.testCase.id}: ${JSON.stringify(resultView(mismatch.result.ours))}`,
    );
  const fixture = {
    schema: 1,
    sourceHash: sourceHash(),
    seed: options.seed,
    count: options.count,
    timeoutMs: options.timeoutMs,
    bash,
    operators,
    coverage: coverage(cases),
    cases: recorded,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  return fixture;
}

function replayFixture(path: string, shellBin: string, expectedCount: number) {
  const { fixture, cases } = parseFixture(
    path,
    JSON.parse(readFileSync(path, "utf8")),
    expectedCount,
  );
  const counts: Counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
  const mismatches: MismatchView[] = [];
  for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index];
    const expected = decodeResult(fixture.cases[index].bash);
    const ours = runProcess(
      shellBin,
      ["-c", fixture.cases[index].script],
      fixture.cases[index].script,
      fixture.timeoutMs,
    );
    const classification = classify(testCase, expected, ours);
    counts[classification]++;
    if (classification === "MISMATCH" && mismatches.length < 50) {
      mismatches.push({
        id: testCase.id,
        operator: testCase.operator,
        quote: testCase.quote,
        featureTags: testCase.featureTags,
        script: fixture.cases[index].script,
        bash: resultView(expected),
        ours: resultView(ours),
      });
    }
  }
  return { path, seed: fixture.seed, total: cases.length, counts, mismatches };
}

function shrinkCase(
  testCase: WordCase,
  bashBin: string,
  shellBin: string,
  timeoutMs: number,
  original: Execution & { case: WordCase },
): Execution & { case: WordCase } {
  if (testCase.fixedScript) return original;
  const candidates: WordCase[] = [];
  const simplify = (patch: Partial<WordCase>) => candidates.push({ ...testCase, ...patch });
  simplify({ quote: "top-level" });
  simplify({ valueState: "empty" });
  simplify({ operandState: "empty" });
  simplify({
    expression: {
      ...testCase.expression,
      source: `\${v${testCase.operator}${testCase.operator.includes("/") ? "x/x" : "x"}}`,
      tags: [testCase.operator],
    },
  });
  for (const candidate of candidates) {
    const run = execute(candidate, bashBin, shellBin, timeoutMs);
    if (run.classification === "MISMATCH") {
      testCase = candidate;
      original = { ...run, case: candidate };
    }
  }
  return original;
}

function incrementCount(map: Record<string, Counts>, key: string, classification: Classification) {
  const bucket = (map[key] ??= { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 });
  bucket[classification]++;
}

function bashVersion(bashBin: string): string {
  return execFileSync(bashBin, ["--version"], { encoding: "utf8" }).split("\n", 1)[0];
}

function ensureQueued() {
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const result = spawnSync(
    "bash",
    [queue, "--class", "light", "brush-web-fuzz", "--", process.execPath, process.argv[1]].concat(
      process.argv.slice(2),
      "--queue-active",
    ),
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function buildShell(options: Options, scratch: string | null): string {
  if (options.shell) return options.shell;
  if (!scratch) throw new Error("scratch directory required");
  const target = resolve(scratch, "target");
  execFileSync(
    "/work/cache/cargo/bin/cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      "shell/Cargo.toml",
      "-p",
      "shell-engine",
      "-j2",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CARGO_HOME: "/work/cache/cargo",
        RUSTUP_HOME: "/work/cache/rustup",
        CARGO_TARGET_DIR: target,
        PATH: `/work/cache/cargo/bin:${process.env.PATH}`,
      },
      stdio: "inherit",
    },
  );
  return resolve(target, "release/shell-engine");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureQueued();
  const scratch = options.shell ? null : mkdtempSync("/work/tmp/brush-web-fuzz-");
  try {
    const shellBin = buildShell(options, scratch);
    if (options.replays.length) {
      const reports = options.replays.map((path) => replayFixture(path, shellBin, options.count));
      const replayReport = { mode: "replay", reports };
      const text = JSON.stringify(replayReport, null, 2) + "\n";
      if (options.output) writeFileSync(options.output, text);
      for (const report of reports)
        console.log(
          `replay ${report.path}: MATCH=${report.counts.MATCH} UNSUPPORTED=${report.counts.UNSUPPORTED} MISMATCH=${report.counts.MISMATCH}`,
        );
      process.stdout.write(text);
      if (reports.some((report) => report.counts.MISMATCH > 0 || report.counts.UNSUPPORTED > 0))
        process.exitCode = 1;
      return;
    }
    const bashBin = process.env.BASH_BIN ?? "bash";
    const cases = generateCases(options.seed, options.count);
    if (options.record) {
      const fixture = recordFixture(options.record, options, cases, bashBin, shellBin);
      console.log(`recorded clean fixture: ${options.record}`);
      console.log(`seed=${fixture.seed} cases=${fixture.cases.length} bash=${fixture.bash}`);
      return;
    }
    const counts: Counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
    const byOperator: Record<string, Counts> = {};
    const byFeature: Record<string, Counts> = {};
    const mismatches: MismatchView[] = [];
    let mismatchTotal = 0;
    for (const testCase of cases) {
      const result = execute(testCase, bashBin, shellBin, options.timeoutMs);
      counts[result.classification]++;
      incrementCount(byOperator, testCase.operator, result.classification);
      for (const feature of testCase.featureTags ?? [])
        incrementCount(byFeature, feature, result.classification);
      if (result.classification !== "MISMATCH") continue;
      mismatchTotal++;
      if (mismatches.length >= 50) continue;
      const minimized = shrinkCase(testCase, bashBin, shellBin, options.timeoutMs, {
        ...result,
        case: testCase,
      });
      mismatches.push({
        id: minimized.case.id,
        operator: minimized.case.operator,
        quote: minimized.case.quote,
        featureTags: minimized.case.featureTags,
        script: minimized.script,
        bash: resultView(minimized.bash),
        ours: resultView(minimized.ours),
      });
    }
    const report = {
      version: 1,
      seed: options.seed,
      generated: options.count,
      total: cases.length,
      timeoutMs: options.timeoutMs,
      bash: bashVersion(bashBin),
      shell: shellBin,
      counts,
      byOperator,
      byFeature,
      mismatchTotal,
      mismatches,
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) writeFileSync(options.output, text);
    console.log(`shell word differential fuzz: seed=${options.seed} cases=${cases.length}`);
    console.log(
      `MATCH=${counts.MATCH} UNSUPPORTED=${counts.UNSUPPORTED} MISMATCH=${counts.MISMATCH}`,
    );
    if (options.output) console.log(`report=${options.output}`);
    if (mismatches.length) {
      console.log(`\nMinimized mismatches (first ${mismatches.length} of ${mismatchTotal}):`);
      for (const mismatch of mismatches) {
        console.log(`\n[${mismatch.id}] ${mismatch.operator} ${mismatch.quote}`);
        console.log(`script: ${mismatch.script}`);
        console.log(`bash(${mismatch.bash.status}): ${JSON.stringify(mismatch.bash.stdout)}`);
        console.log(`ours(${mismatch.ours.status}): ${JSON.stringify(mismatch.ours.stdout)}`);
      }
    }
    console.log("\nFull report:");
    process.stdout.write(text);
    if (mismatches.length) process.exitCode = 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

main();
