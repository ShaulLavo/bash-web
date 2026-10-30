import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  assertOracle,
  assertRecord,
  assertScore,
  bytesDigest,
  digest,
  isRecord,
  verifyOracle,
  validateScore,
} from "./shell-scoreboard.ts";
import type { Oracle, OracleIdentity, Score } from "./shell-scoreboard.ts";

export const oraclePath = "docs/evidence/own-shell-oracle.json";
export const baselinePath = "docs/evidence/own-shell-baseline.json";
export const instrumentReceiptPath = "docs/evidence/own-shell-instrument-migration.json";

export const authorizedInstrumentTransition = Object.freeze({
  target: "9f0bf6a88ebba236a5db9ac3ca6fbe364632db9e",
  fromEnvironment: "507eb1db0221423576b1a0daba7d79a7b2bc3fbbac1a5d86af3a00bc65b29e6a",
  toEnvironment: "563b65495700fa04ee09b312022865864ce51fbd97af0da29a9452d3ce82a9c1",
  fromRunner: "node:wasi",
  toRunner: "waffle-node",
  receiptSha256: "5478df004ad89919bf1cc60b2195f0cab9d2b08bb5cf4497e0cf79b19d3a7d9a",
});

export const runtimeReceiptPath = "docs/evidence/own-shell-runtime-migration.json";
export const authorizedRuntimeTransition = Object.freeze({
  target: "04ca4c1489aa349c4e57327684a24ebf8a9f726c",
  fromEnvironment: "563b65495700fa04ee09b312022865864ce51fbd97af0da29a9452d3ce82a9c1",
  toEnvironment: "6ed3e700fcfca7d03ae94ae372480a00ca737d3baa211cea90659f91c6e94c60",
  fromRunner: "waffle-node",
  toRunner: "waffle-node",
  receiptSha256: "ad938096623d3e8dd3bd6bd0d1e7be7e56f99db1e50005319af6e4b822929a2a",
});

interface ScoreboardPins {
  shellScoreboard?: { oracleSha256?: string };
  [key: string]: unknown;
}
interface ReceiptChange {
  id: string;
  change: string;
  class: string;
  reason: string;
  plan?: string;
  [key: string]: unknown;
}
export interface MigrationReceipt {
  schema: number;
  target: string;
  from: { environment: string };
  to: { environment: string };
  changes: ReceiptChange[];
  [key: string]: unknown;
}

function assertPins(value: unknown): asserts value is ScoreboardPins {
  assertRecord(value);
  if (value.shellScoreboard === undefined) return;
  assertRecord(value.shellScoreboard);
  if (value.shellScoreboard.oracleSha256 === undefined) return;
  assert.equal(typeof value.shellScoreboard.oracleSha256, "string", "invalid scoreboard pin");
}
function assertReceipt(value: unknown): asserts value is MigrationReceipt {
  assertRecord(value);
  assert.equal(typeof value.schema, "number", "invalid instrument receipt schema");
  assert.equal(typeof value.target, "string", "invalid instrument receipt target");
  assertRecord(value.from);
  assert.equal(typeof value.from.environment, "string", "invalid instrument receipt source");
  assertRecord(value.to);
  assert.equal(typeof value.to.environment, "string", "invalid instrument receipt target");
  assert.ok(Array.isArray(value.changes), "invalid instrument receipt changes");
  for (const change of value.changes) {
    assertRecord(change);
    assert.equal(typeof change.id, "string", "invalid receipt case");
    assert.equal(typeof change.change, "string", "invalid receipt change");
    assert.equal(typeof change.class, "string", "invalid receipt classification");
    assert.equal(typeof change.reason, "string", "invalid receipt reason");
  }
}

// Filter before fork startup, not only after the launcher has loaded Node hooks.
export function migrationEnvironment(): Record<string, string> {
  const names = [
    "PATH",
    "HOME",
    "CARGO_HOME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
    "RUSTUP_HOME",
    "WASI_SDK_PATH",
    "WASI_LIBC_SCRATCH_ROOT",
    "TMPDIR",
    "RUNNER_TEMP",
    "SYSTEMROOT",
    "BASH_COMPAT_JOBS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ];
  return Object.fromEntries(
    names.flatMap((name): [string, string][] => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function baseFile(root: string, ref: string, path: string): Buffer {
  assert.match(ref, /^[a-f0-9]{40}$/, "BASH_COMPAT_BASE_REF must be a full commit SHA");
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  assert.equal(
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    ref,
    "BASH_COMPAT_BASE_REF must identify an exact commit",
  );
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Read the target branch's baseline, never a path chosen by the candidate's pin.
export function baseBranchBaseline(root: string, ref: string | undefined): Score | null {
  if (!ref) return null;
  const pins: unknown = JSON.parse(baseFile(root, ref, "sources.lock.json").toString("utf8"));
  assertPins(pins);
  if (!pins.shellScoreboard) return null; // First baseline only. Later omissions fail closed.
  const baseline: unknown = JSON.parse(baseFile(root, ref, baselinePath).toString("utf8"));
  assertScore(baseline);
  return baseline;
}

function targetEvidence(root: string, ref: string, candidateOracle: Oracle) {
  const pins: unknown = JSON.parse(baseFile(root, ref, "sources.lock.json").toString("utf8"));
  assertPins(pins);
  assert.ok(pins.shellScoreboard, "missing target scoreboard pin");
  assert.equal(typeof pins.shellScoreboard.oracleSha256, "string", "target oracle checksum");
  const bytes = baseFile(root, ref, oraclePath);
  assert.equal(bytesDigest(bytes), pins.shellScoreboard.oracleSha256, "target oracle checksum");
  const oracle: unknown = JSON.parse(bytes.toString("utf8"));
  const baseline: unknown = JSON.parse(baseFile(root, ref, baselinePath).toString("utf8"));
  assertOracle(oracle);
  assertScore(baseline);
  verifyOracle(oracle);
  verifyOracle(candidateOracle);
  validateScore(oracle, baseline);
  return { pins, oracle, baseline };
}

export function migrationEvidence(root: string, ref: string, candidateOracle: Oracle) {
  const { pins, oracle, baseline } = targetEvidence(root, ref, candidateOracle);
  const withoutObservations = ({ oracle: _observations, ...identity }: OracleIdentity) => identity;
  assert.deepEqual(
    withoutObservations(candidateOracle.identity),
    withoutObservations(oracle.identity),
    "oracle migration requires unchanged caseSet/environment/sources/schema",
  );
  return { pins, oracle, baseline };
}

function sameExceptEnvironment(target: Oracle, candidate: Oracle): boolean {
  const strip = ({ environment: _environment, identity, ...rest }: Oracle) => ({
    ...rest,
    identity: { ...identity, environment: undefined },
  });
  return JSON.stringify(strip(target)) === JSON.stringify(strip(candidate));
}

export function instrumentMigrationEvidence(
  root: string,
  ref: string,
  candidateOracle: Oracle,
  receipt: MigrationReceipt | undefined = undefined,
) {
  const transition =
    ref === authorizedRuntimeTransition.target
      ? authorizedRuntimeTransition
      : authorizedInstrumentTransition;
  assert.equal(ref, transition.target, "instrument migration is authorized only for its target");
  const { pins, oracle, baseline } = targetEvidence(root, ref, candidateOracle);
  assert.equal(oracle.identity.environment, transition.fromEnvironment, "target environment");
  assert.equal(oracle.environment.runner, transition.fromRunner, "target runner");
  assert.equal(
    candidateOracle.identity.environment,
    transition.toEnvironment,
    "candidate environment",
  );
  assert.equal(candidateOracle.environment.runner, transition.toRunner, "candidate runner");
  assert.ok(
    sameExceptEnvironment(oracle, candidateOracle),
    "instrument migration requires unchanged Bash observations, case set, sources and schema",
  );
  const receiptPath =
    transition === authorizedRuntimeTransition ? runtimeReceiptPath : instrumentReceiptPath;
  const recorded: unknown = receipt ?? JSON.parse(readFileSync(resolve(root, receiptPath), "utf8"));
  assertReceipt(recorded);
  assert.equal(recorded.schema, 1, "instrument receipt schema");
  assert.deepEqual(
    {
      target: recorded.target,
      fromEnvironment: recorded.from?.environment,
      toEnvironment: recorded.to?.environment,
    },
    {
      target: transition.target,
      fromEnvironment: transition.fromEnvironment,
      toEnvironment: transition.toEnvironment,
    },
    "instrument receipt names a different transition",
  );
  const scored = new Set(
    oracle.cases
      .filter((item) => !item.excluded && item.kind === "builtins-only")
      .map((item) => item.id),
  );
  const seen = new Set<string>();
  for (const change of recorded.changes) {
    assert.ok(scored.has(change.id) && !seen.has(change.id), `receipt case ${change.id}`);
    seen.add(change.id);
    assert.ok(["lost", "gained"].includes(change.change), `receipt change ${change.id}`);
    assert.ok(["a", "b"].includes(change.class), `receipt classification ${change.id}`);
    assert.ok(change.reason, `receipt reason ${change.id}`);
    if (change.class === "a") assert.ok(change.plan, `receipt plan item ${change.id}`);
  }
  assert.equal(digest(recorded), transition.receiptSha256, "authorized receipt changed");
  return { pins, oracle, baseline, receipt: recorded };
}

export function assertInstrumentChanges(
  before: Score,
  after: Score,
  receipt: MigrationReceipt,
): void {
  const outcome = new Map(after.cases.map((item) => [item.id, item.outcome]));
  const changes: string[] = [];
  for (const item of before.cases) {
    const next = outcome.get(item.id);
    if (item.outcome === "pass" && next !== "pass") changes.push(`${item.id}:lost`);
    if (item.outcome !== "pass" && next === "pass") changes.push(`${item.id}:gained`);
  }
  assert.deepEqual(
    changes.toSorted(),
    receipt.changes.map((change) => `${change.id}:${change.change}`).toSorted(),
    "rescored target differs from the receipt's recorded transition",
  );
}

const activeMigrations = new Set<ChildProcess>();

// Cancellation owns only launchers created here; the trusted three-argument input stays unchanged.
// Their promises settle after the launcher has drained its consumers and removed its scratch.
export function cancelTargetMigrations(): void {
  for (const child of activeMigrations) child.kill("SIGTERM");
}

// The launcher owns an isolated rebuild, not an evidence/artifact path supplied by the candidate.
// Its IPC connection also gives it a parent-death notification for teardown.
export async function targetBranchBaseline(
  root: string,
  ref: string | undefined,
  oracle: Oracle,
): Promise<Score | null> {
  assert.equal(arguments.length, 3, "target baseline accepts no supplied artifacts or options");
  const baseline = baseBranchBaseline(root, ref);
  if (!baseline) return null;
  assert.ok(ref, "missing immutable base SHA");
  if (baseline.identity.oracle === oracle.identity.oracle) {
    if (baseline.identity.environment === oracle.identity.environment) {
      validateScore(oracle, baseline);
      return baseline;
    }
    instrumentMigrationEvidence(root, ref, oracle);
  } else migrationEvidence(root, ref, oracle);
  for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_BASELINE", "BASH_COMPAT_ORACLE"])
    assert.equal(process.env[name], undefined, `oracle migration rejects supplied ${name}`);
  return new Promise<Score>((resolve, reject) => {
    const child = fork(new URL("./shell-scoreboard-migration.ts", import.meta.url), [root, ref], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: migrationEnvironment(),
      execArgv: [],
    });
    activeMigrations.add(child);
    let result: unknown;
    child.on("message", (message: unknown) => {
      result = message;
    });
    child.once("error", (error) => {
      activeMigrations.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeMigrations.delete(child);
      const score = isRecord(result) ? result.score : undefined;
      const message =
        isRecord(result) && typeof result.error === "string" ? result.error : undefined;
      if (code !== 0 || !score)
        return reject(new Error(message ?? `target rebuild failed (${signal ?? code})`));
      try {
        assertScore(score);
        validateScore(oracle, score);
        resolve(score);
      } catch (error) {
        reject(error);
      }
    });
  });
}
