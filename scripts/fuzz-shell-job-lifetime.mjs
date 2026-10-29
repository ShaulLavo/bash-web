#!/usr/bin/env node
import { encode, decode, validateResultBytes } from "./fuzz-shell-results.ts";
// Original bounded builtin-only job observation grammar. External inherited
// descendants are exercised by RuntimeAbi controls, not simulated by this gate.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
export const defaultCount = 96;
export const defaultTimeoutMs = 2000;
export const scopes = ["top", "function", "subshell"];
export const statuses = [0, 1, 7, 42];
export const families = [
  "wait-pid",
  "wait-job",
  "wait-all",
  "wait-order",
  "wait-pipeline",
  "wait-empty",
  "wait-unknown",
  "nested-parent-status",
  "nested-owned-status",
  "jobs-after-wait",
  "jobs-one-shot",
  "kill-completed",
];
export const generatedStatuses = Array.from({ length: 256 }, (_, status) => status).filter(
  (status) => !statuses.includes(status),
);
export const maxGeneratedCount = families.length * scopes.length * generatedStatuses.length;
export const environment = {
  locale: "C",
  path: "/usr/bin:/bin",
  stdin: "empty",
  shellArgs: ["-c", "SCRIPT"],
  jobControl: "off",
  scope: "builtin-only direct children; inherited external descendants require RuntimeAbi tests",
  completionBarrier: "poll kill -0 on direct child; no fixed sleeps or output-order races",
};
const root = resolve(import.meta.dirname, "..");
const sourcePath = fileURLToPath(import.meta.url);
const bashBin = "/usr/bin/bash";
const oracleVersion = /^GNU bash, version 5\.3\.15(?:\(|\s)/;
const queue = "/work/tmp/wave-heavy/run.sh";
export const sourceFiles = [
  "fuzz-shell-job-lifetime.mjs",
  "fuzz-shell-control-flow.mjs",
  "fuzz-shell-results.ts",
  "shell-process-group.ts",
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
const observe = 'jl_status=$?; printf "status=%s\\n" "$jl_status"; exit "$jl_status"';
const completionBarrier = 'while kill -0 "$jl_pid" 2>/dev/null; do :; done';
const printStatus = (name) => `printf '${name}=%s\\n' "$?"`;
const snapshot = (name) =>
  `jobs >jl_${name}; ${printStatus("jobs-" + name)}; ` +
  `while read -r jl_line; do case "$jl_line" in *Done*) printf '${name}=Done\\n';; *Exit*) printf '${name}=Exit\\n';; *Running*) printf '${name}=Running\\n';; esac; done <jl_${name}`;

export function render(spec) {
  if (
    !families.includes(spec.family) ||
    !scopes.includes(spec.scope) ||
    !Number.isInteger(spec.status) ||
    spec.status < 0 ||
    spec.status > 255
  )
    throw new Error("invalid job-lifetime specification");
  const spawn = `(exit ${spec.status}) & jl_pid=$!`;
  const waitPid = 'wait "$jl_pid"';
  let body;
  switch (spec.family) {
    case "wait-pid":
      body = `${spawn}; ${waitPid}; ${printStatus("first")}; ${waitPid}`;
      break;
    case "wait-job":
      body = `${spawn}; wait %1; ${printStatus("first")}; wait %1; ${printStatus("again")}; ${waitPid}`;
      break;
    case "wait-all":
      body = `${spawn}; wait; ${printStatus("all")}; ${waitPid} 2>/dev/null; ${printStatus("forgotten-pid")}; wait %1 2>/dev/null`;
      break;
    case "wait-order":
      body = `${spawn}; (exit ${(spec.status + 1) % 256}) & jl_other=$!; wait "$jl_other"; ${printStatus("second-launched")}; ${waitPid}`;
      break;
    case "wait-pipeline":
      body = `true | (exit ${spec.status}) & jl_pid=$!; ${waitPid}; ${printStatus("pipeline")}; ${waitPid}`;
      break;
    case "wait-empty":
      body = `wait; ${printStatus("empty")}; ${spawn}; ${waitPid}; ${printStatus("child")}; wait`;
      break;
    case "wait-unknown":
      body = `${spawn}; ${waitPid}; wait 2147483647 2>/dev/null; ${printStatus("unknown-pid")}; ${waitPid}; ${printStatus("remembered")}; wait %9 2>/dev/null`;
      break;
    case "nested-parent-status":
      body = `${spawn}; ( ${waitPid} 2>/dev/null; ${printStatus("not-own-child")} ); ${waitPid}`;
      break;
    case "nested-owned-status":
      body = `( ${spawn}; ${waitPid}; exit "$?" ) & jl_pid=$!; ${waitPid}`;
      break;
    case "jobs-after-wait":
      body = `${spawn}; ${waitPid}; ${printStatus("wait")}; ${snapshot("consumed")}; wait %1 2>/dev/null; ${printStatus("gone-job")}; ${waitPid}`;
      break;
    case "jobs-one-shot":
      body = `${spawn}; ${completionBarrier}; ${snapshot("first")}; ${snapshot("second")}; wait %1 2>/dev/null; ${printStatus("gone-job")}; ${waitPid}`;
      break;
    case "kill-completed":
      body = `${spawn}; ${completionBarrier}; kill -0 "$jl_pid" 2>/dev/null; ${printStatus("numeric-zero")}; kill "$jl_pid" 2>/dev/null; ${printStatus("numeric-kill")}; kill %1 2>/dev/null; ${printStatus("percent-kill")}; ${snapshot("done")}; kill %1 2>/dev/null; ${printStatus("gone-kill")}; ${waitPid}`;
      break;
  }
  if (spec.scope === "function") body = `jl_scope() { ${body}; }; jl_scope`;
  else if (spec.scope === "subshell") body = `( ${body} )`;
  return `${body}\n${observe}\n`;
}
function makeCase(id, spec) {
  return {
    id,
    ...spec,
    tags: [spec.family, "scope=" + spec.scope, "status=" + spec.status],
    script: render(spec),
  };
}
export function matrixCases() {
  const result = [];
  for (const family of families)
    for (const scope of scopes)
      for (const status of statuses)
        result.push(makeCase("matrix-" + result.length, { family, scope, status }));
  return result;
}
export function generateCases(seed, count = defaultCount) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("invalid uint32 seed");
  if (!Number.isSafeInteger(count) || count < 0 || count > maxGeneratedCount)
    throw new Error(`invalid count (0..${maxGeneratedCount})`);
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  // Sample semantic tuples without replacement. Non-matrix byte statuses make
  // every generated script new, not just a fresh id on an existing observation.
  const available = Array.from({ length: maxGeneratedCount }, (_, index) => index);
  const result = matrixCases();
  for (let index = 0; index < count; index++) {
    const selected = next() % available.length;
    const tuple = available[selected];
    available[selected] = available[available.length - 1];
    available.pop();
    result.push(
      makeCase("generated-" + index, {
        family: families[Math.floor(tuple / (scopes.length * generatedStatuses.length))],
        scope: scopes[Math.floor(tuple / generatedStatuses.length) % scopes.length],
        status: generatedStatuses[tuple % generatedStatuses.length],
      }),
    );
  }
  return result;
}
export function coverage(cases) {
  const unique = (key) => Array.from(new Set(cases.map((item) => item[key]))).sort();
  return { families: unique("family"), scopes: unique("scope"), statuses: unique("status") };
}
export function optionsFor(args) {
  const options = sharedOptionsFor(["--count", String(defaultCount)].concat(args));
  if (options.count > maxGeneratedCount) throw new Error(`invalid count (0..${maxGeneratedCount})`);
  return options;
}

export function validateFixture(path, fixture, options) {
  if (
    fixture.schema !== 1 ||
    fixture.sourceHash !== fingerprint() ||
    JSON.stringify(fixture.sourceHashes) !== JSON.stringify(sourceHashes())
  )
    throw new Error("stale job-lifetime fixture hash/schema");
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
  const filenameSeed = /shell-job-lifetime-seed-(\d+)\.json$/.exec(path);
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
export async function execute(cases, options, shell, recorded) {
  const counts = { MATCH: 0, MISMATCH: 0 };
  const byFamily = {};
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
    bashBin,
    [
      queue,
      "--class",
      "light",
      "bash-web-job-lifetime-fuzz",
      "--",
      process.execPath,
      sourcePath,
    ].concat(process.argv.slice(2), ["--queue-active"]),
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/fuzz-shell-job-lifetime.mjs [--shell PATH] [--seed N] [--count 96]\n  --record-oracle PATH  Bash-only recording\n  --record PATH         Record only a strict candidate match\n  --replay PATH         Strict stdout/status replay; repeatable; never invokes Bash\n  --self-control        Independent Bash 5.3.15 observations\n  --output PATH         Bounded diagnostics\nBuiltin-only wait/status/one-shot jobs; external descendants require RuntimeAbi tests.\nNo automatic build. Self-queues through wave-heavy --class light.",
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
  const scratch = mkdtempSync(resolve(parent, "bash-web-job-lifetime-run-"));
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
        const fixture = JSON.parse(readFileSync(path, "utf8"));
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
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
