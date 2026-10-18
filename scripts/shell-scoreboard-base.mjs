import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesDigest, verifyOracle, validateScore } from "./shell-scoreboard.mjs";

export const oraclePath = "docs/evidence/own-shell-oracle.json";
export const baselinePath = "docs/evidence/own-shell-baseline.json";
export const instrumentReceiptPath = "docs/evidence/own-shell-instrument-migration.json";

/**
 * The single authorized replay-instrument transition: main 9f0bf6a's standalone
 * node:wasi/InProcessHost replay to the Waffle Node harness. Bash observations, case
 * set, sources and schema are unchanged; only the replay environment record differs.
 * No other environment change is comparable, here or in any later target.
 */
export const authorizedInstrumentTransition = Object.freeze({
  target: "9f0bf6a88ebba236a5db9ac3ca6fbe364632db9e",
  fromEnvironment: "507eb1db0221423576b1a0daba7d79a7b2bc3fbbac1a5d86af3a00bc65b29e6a",
  toEnvironment: "563b65495700fa04ee09b312022865864ce51fbd97af0da29a9452d3ce82a9c1",
  fromRunner: "node:wasi",
  toRunner: "waffle-node",
});

// Filter before fork startup, not only after the launcher has loaded Node hooks.
export function migrationEnvironment() {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "CARGO_HOME",
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
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

function baseFile(root, ref, path) {
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
export function baseBranchBaseline(root, ref) {
  if (!ref) return null;
  const pins = JSON.parse(baseFile(root, ref, "sources.lock.json"));
  if (!pins.shellScoreboard) return null; // First baseline only. Later omissions fail closed.
  return JSON.parse(baseFile(root, ref, baselinePath));
}

// The target's checksummed oracle and its validated baseline, beside a verified candidate.
function targetEvidence(root, ref, candidateOracle) {
  const pins = JSON.parse(baseFile(root, ref, "sources.lock.json"));
  const bytes = baseFile(root, ref, oraclePath);
  assert.equal(bytesDigest(bytes), pins.shellScoreboard.oracleSha256, "target oracle checksum");
  const oracle = JSON.parse(bytes);
  const baseline = JSON.parse(baseFile(root, ref, baselinePath));
  verifyOracle(oracle);
  verifyOracle(candidateOracle);
  validateScore(oracle, baseline);
  return { pins, oracle, baseline };
}

export function migrationEvidence(root, ref, candidateOracle) {
  const { pins, oracle, baseline } = targetEvidence(root, ref, candidateOracle);
  const withoutObservations = ({ oracle: _observations, ...identity }) => identity;
  assert.deepEqual(
    withoutObservations(candidateOracle.identity),
    withoutObservations(oracle.identity),
    "oracle migration requires unchanged caseSet/environment/sources/schema",
  );
  return { pins, oracle, baseline };
}

function sameExceptEnvironment(target, candidate) {
  const strip = ({ environment: _environment, identity, ...rest }) => ({
    ...rest,
    identity: { ...identity, environment: undefined },
  });
  return JSON.stringify(strip(target)) === JSON.stringify(strip(candidate));
}

/**
 * Validate the authorized instrument transition and its committed receipt; throw otherwise.
 * @param {string} root
 * @param {string} ref
 * @param {any} candidateOracle
 * @param {any} [receipt] the committed receipt unless supplied (tests only)
 */
export function instrumentMigrationEvidence(root, ref, candidateOracle, receipt = undefined) {
  const transition = authorizedInstrumentTransition;
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
  const recorded =
    receipt ?? JSON.parse(readFileSync(resolve(root, instrumentReceiptPath), "utf8"));
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
  const seen = new Set();
  for (const change of recorded.changes) {
    assert.ok(scored.has(change.id) && !seen.has(change.id), `receipt case ${change.id}`);
    seen.add(change.id);
    assert.ok(["lost", "gained"].includes(change.change), `receipt change ${change.id}`);
    assert.ok(["a", "b"].includes(change.class), `receipt classification ${change.id}`);
    assert.ok(change.reason, `receipt reason ${change.id}`);
    if (change.class === "a") assert.ok(change.plan, `receipt plan item ${change.id}`);
  }
  return { pins, oracle, baseline, receipt: recorded };
}

/** Exact per-case transition proof: the rescored target differs only by the receipt's changes. */
export function assertInstrumentChanges(before, after, receipt) {
  const outcome = new Map(after.cases.map((item) => [item.id, item.outcome]));
  const changes = [];
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

const activeMigrations = new Set();

// Cancellation owns only launchers created here; the trusted three-argument input stays unchanged.
// Their promises settle after the launcher has drained its consumers and removed its scratch.
export function cancelTargetMigrations() {
  for (const child of activeMigrations) child.kill("SIGTERM");
}

// The launcher owns an isolated rebuild, not an evidence/artifact path supplied by the candidate.
// Its IPC connection also gives it a parent-death notification for teardown.
export async function targetBranchBaseline(root, ref, oracle) {
  assert.equal(arguments.length, 3, "target baseline accepts no supplied artifacts or options");
  const baseline = baseBranchBaseline(root, ref);
  if (!baseline) return null;
  if (baseline.identity.oracle === oracle.identity.oracle) {
    if (baseline.identity.environment === oracle.identity.environment) {
      validateScore(oracle, baseline);
      return baseline;
    }
    // Only the recorded one-time transition may rescore the target; anything else
    // is an incomparable environment and fails closed.
    instrumentMigrationEvidence(root, ref, oracle);
  } else migrationEvidence(root, ref, oracle);
  for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_BASELINE", "BASH_COMPAT_ORACLE"])
    assert.equal(process.env[name], undefined, `oracle migration rejects supplied ${name}`);
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./shell-scoreboard-migration.mjs", import.meta.url), [root, ref], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: migrationEnvironment(),
      execArgv: [],
    });
    activeMigrations.add(child);
    let result;
    child.on("message", (message) => {
      result = message;
    });
    child.once("error", (error) => {
      activeMigrations.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeMigrations.delete(child);
      if (code !== 0 || !result?.score)
        return reject(new Error(result?.error ?? `target rebuild failed (${signal ?? code})`));
      try {
        validateScore(oracle, result.score);
        resolve(result.score);
      } catch (error) {
        reject(error);
      }
    });
  });
}
