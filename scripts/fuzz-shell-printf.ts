#!/usr/bin/env node
import { validateResultBytes } from "./fuzz-shell-results.ts";
// Original bounded printf-escape grammar. Fixture/CLI scaffolding adapts the
// job-lifetime generator at 0630e1d; raw process helpers are imported unchanged.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  healthy,
  matches,
  optionsFor as sharedOptionsFor,
  outputLimit,
  run,
} from "./fuzz-shell-control-flow.mjs";

export { healthy, matches, outputLimit, run };
import {
  encode,
  decode,
  type FuzzFixture,
  type FuzzOptions,
  type RecordedCase,
} from "./fuzz-shell-results.ts";
type Case = ReturnType<typeof generateCases>[number];

export const defaultCount = 128;
export const defaultTimeoutMs = 2000;
export const modes = ["format", "percent-b"];
// First 102 scripts and the five sequences below reproduce the original raw-byte
// Bash investigation exactly, including its observable post-command status.
export const originalEscapes = [
  "\\a",
  "\\b",
  "\\e",
  "\\E",
  "\\f",
  "\\n",
  "\\r",
  "\\t",
  "\\v",
  "\\\\",
  "\\c",
  "\\0",
  "\\00",
  "\\000",
  "\\0000",
  "\\001",
  "\\007",
  "\\033",
  "\\077",
  "\\100",
  "\\177",
  "\\200",
  "\\377",
  "\\400",
  "\\777",
  "\\0123",
  "\\0777",
  "\\00000",
  "\\1",
  "\\12",
  "\\123",
  "\\1234",
  "\\08",
  "\\078",
  "\\x",
  "\\x0",
  "\\x00",
  "\\x1b",
  "\\x7F",
  "\\x80",
  "\\xff",
  "\\x100",
  "\\xg1",
  "\\x1g",
  "\\q",
  '\\"',
  "\\'",
  "\\?",
  "\\u0041",
  "\\U00000041",
  "\\",
];
export const boundaryEscapes = [
  "\\01",
  "\\07",
  "\\010",
  "\\037",
  "\\040",
  "\\0177",
  "\\0200",
  "\\0377",
  "\\0400",
  "\\01000",
  "\\07777",
  "\\0000008",
  "\\123456",
  "\\7777",
  "\\8",
  "\\9",
  "\\09",
  "\\099",
  "\\378",
  "\\008",
  "\\7777777777777777777777777777",
  "\\x1",
  "\\xF",
  "\\xFF",
  "\\x000",
  "\\x001",
  "\\x7ff",
  "\\xffff",
  "\\xfg",
  "\\xG0",
  "\\x-1",
  "\\x+1",
  "\\x 1",
  "\\x\\n",
  "\\x\\c",
  "\\x\\x41",
  "\\u",
  "\\uQ",
  "\\u1",
  "\\u12",
  "\\u123",
  "\\u1234",
  "\\u12345",
  "\\u0000",
  "\\u007f",
  "\\u0080",
  "\\u07ff",
  "\\u0800",
  "\\ud7ff",
  "\\ud800",
  "\\udbff",
  "\\udc00",
  "\\udfff",
  "\\ue000",
  "\\uffff",
  "\\uFFFF",
  "\\u-1",
  "\\u+1",
  "\\u 1",
  "\\u12g4",
  "\\u\\n",
  "\\U",
  "\\UQ",
  "\\U1",
  "\\U12",
  "\\U123",
  "\\U1234",
  "\\U12345",
  "\\U123456",
  "\\U1234567",
  "\\U12345678",
  "\\U00000000",
  "\\U0000007f",
  "\\U00000080",
  "\\U000007ff",
  "\\U00000800",
  "\\U0000ffff",
  "\\U0000d800",
  "\\U0000dfff",
  "\\U00010000",
  "\\U0010ffff",
  "\\U00110000",
  "\\U001fffff",
  "\\U00200000",
  "\\U03ffffff",
  "\\U04000000",
  "\\U7fffffff",
  "\\U80000000",
  "\\Uffffffff",
  "\\U100000000",
  "\\Ufffffffff",
  "\\U-1",
  "\\U+1",
  "\\U 1",
  "\\U1234567g",
  "\\A",
  "\\B",
  "\\C",
  "\\N",
  "\\s",
  "\\z",
  "\\_",
  "\\/",
  "\\:",
  "\\ ",
  "\\\n",
  "\\\t",
  "\\\\n",
  "\\\\c",
  "\\a\\b\\e\\E\\f\\n\\r\\t\\v\\\\",
  "\\000\\377\\xFF",
  "\\c\\x",
  "\\c\\u",
  "\\x\\cZ",
].filter((value) => !originalEscapes.includes(value));
export const originalSequences = [
  "printf '%b:%s\\n' 'a\\cb' after tail; printf '|continued|'",
  "printf 'a\\cb%s' X Y; printf '|continued|'",
  "printf '%b' '\\0' '\\377' '\\0377' '\\xFF'; printf '|continued|'",
  "printf '%b:%s' '\\x' arg next tail; printf '|continued|'",
  "printf '\\000%s\\377' one two; printf '|continued|'",
];
const statusTail = 'pf_status=$?; printf "|status:%s|" "$pf_status"; exit "$pf_status"';
export const sequenceBodies = [
  "printf '%b:%s' 'a\\cb' after tail more",
  "printf 'a\\cb%s' X Y",
  "printf '%b:%b:%s' 'a\\cb' '\\x' after",
  "printf '%b:%b:%s' first 'a\\cb' after remaining",
  "printf '%b:%s' first one 'a\\cb' two third three",
  "printf 'A\\cZ%b' '\\x41' '\\x42'",
  "printf 'A\\cZ%b' 'a\\cb' later",
  "printf '%b|%s;' '\\0' one '\\0377' two '\\xFF' three",
  "printf '\\x41%s\\xFF;' one two three",
  "printf '%b%s' '\\x' one '\\x41' two",
  "printf 'prefix\\x%s' one two",
  "printf '%b|%s;' '\\u' one '\\u0041' two",
  "printf 'prefix\\u%s' one two",
  "printf '%b|%s;' '\\U' one '\\U00000041' two",
  "printf '%b|%s;' '\\xg1' one '\\x41' two",
  "printf '%b|%s;' '\\uQ' one '\\u0041' two",
  "printf '%b|%s;' '\\UQ' one '\\U00000041' two",
  "printf '%b' 'before\\000after\\377end'",
  "printf 'before\\000after\\377end'",
  "printf '%s' '\\xFF\\000\\c\\u0041'",
  "printf '%b' '\\x41' '\\x42' '\\x43'",
  "printf '\\x41%s' one two",
  "printf '%b' 'A\\cZ'; printf '%s' shell-continued",
  "printf 'A\\cZ'; printf '%s' shell-continued",
];
export const utf8Escapes = [
  "\\u0000",
  "\\u007f",
  "\\u0080",
  "\\u00e9",
  "\\u07ff",
  "\\u0800",
  "\\ud800",
  "\\udfff",
  "\\uffff",
  "\\U000000e9",
  "\\U0000d800",
  "\\U0010ffff",
  "\\U00110000",
  "\\U001fffff",
  "\\U00200000",
  "\\U03ffffff",
  "\\U04000000",
  "\\U7fffffff",
  "\\U80000000",
  "\\Uffffffff",
  "\\u",
  "\\UQ",
];
export const localeAssignments = [
  "LC_ALL=C.UTF-8",
  "LC_ALL=POSIX",
  "LC_ALL=C; LC_CTYPE=C.UTF-8; LANG=C.UTF-8",
  "LC_ALL=; LC_CTYPE=C.UTF-8; LANG=C",
  "LC_ALL=; LC_CTYPE=C; LANG=C.UTF-8",
  "LC_ALL=; LC_CTYPE=; LANG=C.UTF-8",
  "LC_ALL=; LC_CTYPE=; LANG=C",
  "LC_ALL=; LC_CTYPE=; LANG=",
  "LC_ALL=C.UTF-8; LC_CTYPE=C; LANG=C",
  "unset LC_ALL LC_CTYPE; LANG=C.UTF-8",
  "unset LC_ALL LC_CTYPE LANG",
];
export const generatedSuffixes = ["0", "f", "G", "\\000", "\\0377", "\\777", "\\u0080", "\\q"];
export const generatedModes = ["format", "percent-b", "format-repeat", "b-repeat"];
export const maxGeneratedCount = 256 * generatedSuffixes.length * generatedModes.length;
export const environment = {
  locale:
    "C; only explicit locale controls assign C.UTF-8/POSIX or exercise LC_ALL/LC_CTYPE/LANG precedence",
  path: "/usr/bin:/bin",
  stdin: "empty",
  shellArgs: ["-c", "SCRIPT"],
  jobControl: "off",
  scope:
    "printf format and %b escapes only; %s is an existing literal/repetition control; no flags or other conversions",
  isolation: "fresh cwd, HOME, TMPDIR and sanitized environment per observation",
  comparison:
    "healthy process, exact exit status and raw stdout bytes; raw stderr retained for diagnostics only",
};
const root = resolve(import.meta.dirname, "..");
const sourcePath = fileURLToPath(import.meta.url);
const bashBin = "/usr/bin/bash";
const oracleVersion = /^GNU bash, version 5\.3\.15(?:\(|\s)/;
const queue = "/work/platform-production/heavy/current/run.js";
export const sourceFiles = [
  "fuzz-shell-printf.ts",
  "fuzz-shell-control-flow.mjs",
  "fuzz-shell-results.ts",
  "shell-process-group.mjs",
];
export const sourceHashes = () =>
  Object.fromEntries(
    sourceFiles.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    ]),
  );
export const fingerprint = () =>
  createHash("sha256").update(JSON.stringify(sourceHashes())).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
type Spec = { family: string; mode: string; value: string; variant: number };
export function render(spec: Spec) {
  if (!spec || typeof spec.value !== "string" || !Number.isInteger(spec.variant))
    throw new Error("invalid printf specification");
  if (spec.family === "original-sequence") {
    if (spec.mode !== "sequence" || spec.value !== "" || !originalSequences[spec.variant])
      throw new Error("invalid printf specification");
    return originalSequences[spec.variant];
  }
  if (spec.family === "sequence") {
    if (spec.mode !== "sequence" || spec.value !== "" || !sequenceBodies[spec.variant])
      throw new Error("invalid printf specification");
    return sequenceBodies[spec.variant] + "; " + statusTail;
  }
  if (spec.family === "escape" || spec.family === "trailing") {
    if (
      !modes.includes(spec.mode) ||
      spec.variant !== 0 ||
      (spec.family === "trailing" && !["\\", "\\x", "\\u", "\\U", "\\c"].includes(spec.value))
    )
      throw new Error("invalid printf specification");
    const value = "A" + spec.value + (spec.family === "escape" ? "Z" : "");
    return (
      (spec.mode === "format" ? "printf " + quote(value) : "printf '%b' " + quote(value)) +
      "; printf '|after:%s|' \"$?\""
    );
  }
  if (spec.family === "locale") {
    if (
      !modes.includes(spec.mode) ||
      spec.variant < 0 ||
      spec.variant >= localeAssignments.length ||
      (spec.variant === 0 ? !utf8Escapes.includes(spec.value) : spec.value !== "\\u00e9")
    )
      throw new Error("invalid printf specification");
    const body =
      spec.mode === "format"
        ? "printf " + quote("A" + spec.value + "Z")
        : "printf '%b' " + quote("A" + spec.value + "Z");
    return localeAssignments[spec.variant] + "; " + body + "; " + statusTail;
  }
  if (spec.family === "generated") return renderGenerated(spec);
  throw new Error("invalid printf specification");
}
function renderGenerated(spec: Spec) {
  if (
    !generatedModes.includes(spec.mode) ||
    spec.variant < 0 ||
    spec.variant >= generatedSuffixes.length ||
    !/^\\x[0-9a-f]{2}$/.test(spec.value)
  )
    throw new Error("invalid printf specification");
  const value = "generated:" + spec.value + generatedSuffixes[spec.variant] + ":end";
  let body;
  if (spec.mode === "format") body = "printf " + quote(value);
  else if (spec.mode === "percent-b") body = "printf '%b' " + quote(value);
  else if (spec.mode === "format-repeat") body = "printf " + quote(value + "%s;") + " one two";
  else body = "printf '%b:%s;' " + quote(value) + " one " + quote(value) + " two";
  return body + "; " + statusTail;
}
function makeCase(id: string, spec: Spec) {
  return { id, ...spec, tags: [spec.family, "mode=" + spec.mode], script: render(spec) };
}
export function matrixCases() {
  const result = [];
  const addEscapes = (values: string[], family = "escape") => {
    for (const mode of modes)
      for (const value of values)
        result.push(makeCase("matrix-" + result.length, { family, mode, value, variant: 0 }));
  };
  addEscapes(originalEscapes);
  for (const variant of originalSequences.keys())
    result.push(
      makeCase("matrix-" + result.length, {
        family: "original-sequence",
        mode: "sequence",
        value: "",
        variant,
      }),
    );
  addEscapes(boundaryEscapes);
  addEscapes(["\\", "\\x", "\\u", "\\U", "\\c"], "trailing");
  for (const variant of sequenceBodies.keys())
    result.push(
      makeCase("matrix-" + result.length, {
        family: "sequence",
        mode: "sequence",
        value: "",
        variant,
      }),
    );
  for (const mode of modes) {
    for (const value of utf8Escapes)
      result.push(
        makeCase("matrix-" + result.length, { family: "locale", mode, value, variant: 0 }),
      );
    for (let variant = 1; variant < localeAssignments.length; variant++)
      result.push(
        makeCase("matrix-" + result.length, { family: "locale", mode, value: "\\u00e9", variant }),
      );
  }
  return result;
}
export function generateCases(seed: number, count = defaultCount) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("invalid uint32 seed");
  if (!Number.isSafeInteger(count) || count < 0 || count > maxGeneratedCount)
    throw new Error(`invalid count (0..${maxGeneratedCount})`);
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const available = Array.from({ length: maxGeneratedCount }, (_, index) => index);
  const result = matrixCases();
  for (let index = 0; index < count; index++) {
    const selected = next() % available.length;
    const tuple = available[selected];
    available[selected] = available[available.length - 1];
    available.pop();
    result.push(
      makeCase("generated-" + index, {
        family: "generated",
        mode: generatedModes[Math.floor(tuple / (256 * generatedSuffixes.length))],
        value:
          "\\x" +
          (Math.floor(tuple / generatedSuffixes.length) % 256).toString(16).padStart(2, "0"),
        variant: tuple % generatedSuffixes.length,
      }),
    );
  }
  return result;
}
export function coverage(cases: readonly Case[]) {
  const unique = (key: keyof Case) => Array.from(new Set(cases.map((item) => item[key]))).sort();
  return { families: unique("family"), modes: unique("mode") };
}
export function optionsFor(args: string[]) {
  const options = sharedOptionsFor(["--count", String(defaultCount)].concat(args));
  if (options.count > maxGeneratedCount) throw new Error(`invalid count (0..${maxGeneratedCount})`);
  return options;
}
export function validateFixture(path: string, fixture: FuzzFixture<Case>, options: FuzzOptions) {
  if (
    fixture.schema !== 1 ||
    fixture.sourceHash !== fingerprint() ||
    JSON.stringify(fixture.sourceHashes) !== JSON.stringify(sourceHashes())
  )
    throw new Error("stale printf fixture hash/schema");
  if (
    !oracleVersion.test(fixture.bash ?? "") ||
    fixture.oraclePath !== bashBin ||
    JSON.stringify(fixture.environment) !== JSON.stringify(environment)
  )
    throw new Error("fixture oracle/environment differs");
  if (!["oracle-only", "candidate-verified"].includes(fixture.provenance))
    throw new Error("fixture provenance differs");
  if (fixture.count !== options.count || fixture.timeoutMs !== options.timeoutMs)
    throw new Error("fixture count/timeout differs");
  if (
    !Number.isInteger(fixture.seed) ||
    fixture.seed < 0 ||
    fixture.seed > 0xffffffff ||
    (options.explicitSeed && fixture.seed !== options.seed)
  )
    throw new Error("fixture seed differs");
  const filenameSeed = /shell-printf-seed-(\d+)\.json$/.exec(path);
  if (!filenameSeed || Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed differs");
  const cases = generateCases(fixture.seed, fixture.count);
  if (JSON.stringify(fixture.coverage) !== JSON.stringify(coverage(cases)))
    throw new Error("fixture coverage differs");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== cases.length)
    throw new Error("fixture length differs");
  for (const [index, item] of cases.entries()) {
    const entry = fixture.cases[index];
    if (JSON.stringify(entry?.case) !== JSON.stringify(item))
      throw new Error("fixture case differs at " + index);
    if (!entry?.bash || !healthy(entry.bash))
      throw new Error("invalid fixture process result at " + index);
    validateResultBytes(entry.bash, outputLimit, index);
  }
  return cases;
}
export async function execute<T extends { id: string; family: string; script: string }>(
  cases: readonly T[],
  options: Pick<FuzzOptions, "cwd" | "timeoutMs" | "interrupted" | "record" | "recordOracle">,
  shell: string,
  recorded?: readonly Pick<RecordedCase<T>, "bash">[],
) {
  const counts = { MATCH: 0, MISMATCH: 0 };
  const byFamily: Record<string, { MATCH: number; MISMATCH: number }> = {};
  const mismatches = [];
  const results = [];
  for (const [index, item] of cases.entries()) {
    if (options.interrupted) throw new Error("interrupted");
    const bash = recorded ? decode(recorded[index].bash) : await run(bashBin, item.script, options);
    if (!healthy(bash))
      throw new Error("unrecordable oracle: " + item.id + " " + JSON.stringify(encode(bash)));
    if (options.record || options.recordOracle) results.push({ case: item, bash: encode(bash) });
    if (options.recordOracle) continue;
    const candidate = await run(shell, item.script, options);
    const outcome = matches(bash, candidate) ? "MATCH" : "MISMATCH";
    counts[outcome]++;
    (byFamily[item.family] ??= { MATCH: 0, MISMATCH: 0 })[outcome]++;
    if (outcome === "MISMATCH" && mismatches.length < 24)
      mismatches.push({ case: item, bash: encode(bash), candidate: encode(candidate) });
  }
  return { total: cases.length, counts, byFamily, mismatches, results };
}
function ensureQueued() {
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const child = spawnSync(
    "bun",
    [queue, "--class", "light", "bash-web-printf-fuzz", "--", process.execPath, sourcePath].concat(
      process.argv.slice(2),
      ["--queue-active"],
    ),
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/fuzz-shell-printf.mjs [--shell PATH] [--seed N] [--count 128]\n  --record-oracle PATH  Bash-only recording\n  --record PATH         Record only a strict candidate match\n  --replay PATH         Strict stdout/status replay; repeatable; never invokes Bash\n  --self-control        Independent Bash 5.3.15 observations\n  --output PATH         Bounded diagnostics\nFormat/%b escapes, raw bytes, Unicode under LC_ALL=C; no unrelated flags/conversions.\nNo automatic build. Self-queues through installed heavy runner --class light. No output normalization.",
    );
    return;
  }
  ensureQueued();
  const shell = options.selfControl
    ? bashBin
    : (options.shell ??
      process.env.FUZZ_SHELL_BIN ??
      resolve(root, ".build/shell/release/shell-engine"));
  if (!options.recordOracle && !existsSync(shell))
    throw new Error("pass an existing native --shell PATH: " + shell);
  if (options.record && realpathSync(shell) === realpathSync(bashBin))
    throw new Error("cannot candidate-verify against Bash itself; use --record-oracle");
  const parent = process.env.FUZZ_JOB_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp";
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "bash-web-printf-run-"));
  options.cwd = scratch;
  // Shared run() owns each process group through close and drain, with a finite
  // timeout. A signal stops new observations; await in-flight teardown before rm.
  const onSignal = () => {
    options.interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const reports = [];
    if (options.replays.length) {
      const inputs = options.replays.map((path) => {
        const fixture: FuzzFixture<Case> = JSON.parse(readFileSync(path, "utf8"));
        return { path, fixture, cases: validateFixture(path, fixture, options) };
      });
      for (const { path, fixture, cases } of inputs)
        reports.push({
          path,
          seed: fixture.seed,
          ...(await execute(cases, options, shell, fixture.cases)),
        });
    } else {
      const bash = execFileSync(bashBin, ["--version"], {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        timeout: options.timeoutMs,
        maxBuffer: outputLimit,
      }).split("\n", 1)[0];
      if (!oracleVersion.test(bash)) throw new Error("Bash 5.3.15 required, got " + bash);
      const cases = generateCases(options.seed, options.count);
      const result = await execute(cases, options, shell);
      reports.push({ seed: options.seed, bash, ...result });
      const recordPath = options.record ?? options.recordOracle;
      if (recordPath && result.counts.MISMATCH)
        throw new Error("refusing candidate-verified recording with differences");
      if (recordPath) {
        const fixture = {
          schema: 1,
          sourceHash: fingerprint(),
          sourceHashes: sourceHashes(),
          seed: options.seed,
          count: options.count,
          timeoutMs: options.timeoutMs,
          bash,
          oraclePath: bashBin,
          environment,
          provenance: options.recordOracle ? "oracle-only" : "candidate-verified",
          coverage: coverage(cases),
          cases: result.results,
        };
        validateFixture(recordPath, fixture, options);
        mkdirSync(dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, JSON.stringify(fixture, null, 2) + "\n");
      }
    }
    const report = {
      schema: 1,
      sourceHash: fingerprint(),
      environment,
      mode: options.replays.length
        ? "replay"
        : options.recordOracle
          ? "oracle-only"
          : options.selfControl
            ? "bash-self-control"
            : "live",
      shell: options.recordOracle ? null : shell,
      reports: reports.map(({ results: _results, ...report }) => report),
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) {
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, text);
    }
    process.stdout.write(text);
    if (options.interrupted) process.exitCode = 130;
    else if (reports.some((report) => report.counts.MISMATCH)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    rmdirSync(scratch);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
