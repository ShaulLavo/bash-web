// Internal launcher: no baseline or binary inputs. The target commit supplies the scorer and source.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertInstrumentChanges,
  baseBranchBaseline,
  instrumentMigrationEvidence,
  migrationEnvironment,
  migrationEvidence,
  oraclePath,
} from "./shell-scoreboard-base.mjs";
import {
  bytesDigest,
  compareScores,
  summarize,
  validateScore,
  verifyOracle,
} from "./shell-scoreboard.mjs";
import { wasiCargoEnvironment, wasiSysrootCommand } from "./wasi-build.ts";
import { drainGroup, killGroup } from "./shell-process-group.ts";

const root = resolve(process.argv[2] ?? ".");
const ref = process.argv[3];
const children = new Map();
let interrupted = false;
function stop() {
  interrupted = true;
  for (const [pid, child] of children) {
    killGroup(pid, "SIGTERM");
    child.timer ??= setTimeout(() => killGroup(pid, "SIGKILL"), 2000).unref();
  }
}
for (const signal of ["SIGTERM", "SIGINT", "disconnect"]) process.on(signal, stop);

// Do not inherit compiler wrappers/flags, alternate Cargo targets, Node hooks, Git replacements,
// scorer overrides, or any candidate-provided artifacts. Shared dependency caches remain usable.
const env = migrationEnvironment();
env.GIT_NO_REPLACE_OBJECTS = "1";
function run(command, args, cwd, extraEnv = {}) {
  assert.ok(!interrupted, "target rebuild interrupted");
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    const state = {};
    if (child.pid) children.set(child.pid, state);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      // Keep ownership of the entire group after its leader exits, until no consumers remain.
      drainGroup(child.pid).then(() => {
        clearTimeout(state.timer);
        children.delete(child.pid);
        if (code === 0 && !interrupted) accept();
        else
          reject(
            new Error(`${command} failed (${signal ?? code})${interrupted ? ": interrupted" : ""}`),
          );
      }, reject);
    });
  });
}

const cargoBuild = (args, cwd, targetDir) =>
  run(
    "cargo",
    ["build", "--locked", "--release", "--target", "wasm32-wasip1"].concat(args, ["-j2"]),
    cwd,
    { ...wasiCargoEnvironment(root, targetDir, env), CARGO_INCREMENTAL: "0" },
  );
const verify = (path) =>
  run(
    process.execPath,
    [fileURLToPath(new URL("./verify-wasi-guests.ts", import.meta.url)), path],
    root,
  );

async function targetUtilityNames(checkout) {
  const directory = resolve(checkout, "shell/utilities/src/bin");
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

async function buildTarget(checkout, targetDir, runner) {
  const [prepareCommand, prepareArgs] = wasiSysrootCommand(root);
  await run(prepareCommand, prepareArgs, root);
  const manifest = ["--manifest-path", "shell/Cargo.toml"];
  const release = resolve(targetDir, "wasm32-wasip1/release");
  if (runner !== "waffle-node") {
    await cargoBuild(
      manifest.concat(["-p", "shell-engine", "--bin", "shell-engine"]),
      checkout,
      targetDir,
    );
    await verify(resolve(release, "shell-engine.wasm"));
    return { wasm: resolve(release, "shell-engine.wasm") };
  }
  await cargoBuild(
    manifest.concat([
      "-p",
      "shell-engine",
      "--bin",
      "shell-runtime",
      "-p",
      "shell-compat-fixtures",
    ]),
    checkout,
    targetDir,
  );
  for (const name of ["shell-runtime", "argv-py", "printenv-py"])
    await verify(resolve(release, `${name}.wasm`));
  const cache = process.env.NPM_CONFIG_CACHE ?? process.env.npm_config_cache;
  await run("npm", ["ci", "--ignore-scripts"], checkout, cache ? { NPM_CONFIG_CACHE: cache } : {});
  await run(process.execPath, ["scripts/build-node-harness.ts"], checkout);
  return { wasm: resolve(release, "shell-runtime.wasm"), fixtures: release };
}

async function cleanupTarget(scratch) {
  // Never remove files from under an uninterruptible consumer.
  assert.equal(children.size, 0, `target processes remain; scratch retained at ${scratch}`);
  await rm(scratch, { recursive: true, force: true });
}

async function targetCheckout(kind, paths) {
  const scratchRoot = process.env.RUNNER_TEMP ?? "/work/tmp/bash-web-climb-subst";
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(resolve(scratchRoot, `audit-${kind}-migration-`));
  const checkout = resolve(scratch, "target");
  const archive = resolve(scratch, "target.tar");
  try {
    await mkdir(checkout);
    await run("git", ["archive", "--format=tar", `--output=${archive}`, ref].concat(paths), root);
    await run("tar", ["-xf", archive, "-C", checkout], scratch);
    await rm(archive);
    return { scratch, checkout, targetDir: resolve(scratch, "cargo-target") };
  } catch (error) {
    await cleanupTarget(scratch);
    throw error;
  }
}

async function rescoreUnderCandidateInstrument(candidate) {
  const { baseline, receipt } = instrumentMigrationEvidence(root, ref, candidate);
  const { scratch, checkout, targetDir } = await targetCheckout("instrument", [
    "shell",
    "rust-toolchain.toml",
  ]);
  try {
    const [prepareCommand, prepareArgs] = wasiSysrootCommand(root);
    await run(prepareCommand, prepareArgs, root);
    const utilities = existsSync(resolve(checkout, "shell/utilities/Cargo.toml"))
      ? await targetUtilityNames(checkout)
      : [];
    const binaries = ["shell-runtime"].concat(utilities);
    await cargoBuild(
      ["--manifest-path", "shell/Cargo.toml", "-p", "shell-engine"]
        .concat(utilities.length ? ["-p", "shell-utilities"] : [])
        .concat(binaries.flatMap((name) => ["--bin", name])),
      checkout,
      targetDir,
    );
    const release = resolve(targetDir, "wasm32-wasip1/release");
    const wasm = resolve(release, "shell-runtime.wasm");
    for (const name of binaries) await verify(resolve(release, `${name}.wasm`));
    await cargoBuild(
      ["--manifest-path", resolve(root, "shell/Cargo.toml"), "-p", "shell-compat-fixtures"],
      root,
      targetDir,
    );
    for (const name of ["argv-py", "printenv-py"]) await verify(resolve(release, `${name}.wasm`));
    await run(process.execPath, ["scripts/build-node-harness.ts"], root);
    const binaryHash = bytesDigest(await readFile(wasm));
    const output = resolve(scratch, "target-under-candidate-instrument.json");
    await run(process.execPath, ["scripts/bash-compat.ts"], root, {
      BASH_COMPAT_MODE: "frozen",
      BASH_COMPAT_ENGINES: "own-shell",
      BASH_COMPAT_JOBS: process.env.BASH_COMPAT_JOBS ?? "4",
      BASH_COMPAT_TIMEOUT_MS: String(candidate.environment.timeoutMs),
      BASH_COMPAT_SKIP_BUILD: "1",
      BASH_COMPAT_RECORD: "1",
      BASH_COMPAT_SHELL_WASM: wasm,
      BASH_COMPAT_FIXTURE_DIR: release,
      BASH_COMPAT_UTILITY_DIR: utilities.length ? release : process.env.BASH_COMPAT_UTILITY_DIR,
      BASH_COMPAT_OUT: output,
      BASH_COMPAT_SCRATCH: scratch,
    });
    assert.equal(
      bytesDigest(await readFile(wasm)),
      binaryHash,
      "target binary changed while scoring",
    );
    const rescored = JSON.parse(await readFile(output, "utf8"));
    validateScore(candidate, rescored);
    assertInstrumentChanges(baseline, rescored, receipt);
    console.error(
      `[instrument-migration-proof] ${JSON.stringify({
        baseRef: ref,
        engineSha256: binaryHash,
        from: receipt.from.environment,
        to: receipt.to.environment,
        changes: receipt.changes.length,
      })}`,
    );
    return rescored;
  } finally {
    await cleanupTarget(scratch);
  }
}

async function migrate() {
  assert.equal(
    process.argv.length,
    4,
    "migration launcher accepts only repository and immutable base SHA",
  );
  const candidateBytes = await readFile(resolve(root, oraclePath));
  const candidate = JSON.parse(candidateBytes);
  verifyOracle(candidate);
  const candidatePins = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
  assert.equal(
    candidatePins.shellScoreboard.oracleSha256,
    bytesDigest(candidateBytes),
    "candidate oracle checksum",
  );
  if (baseBranchBaseline(root, ref)?.identity.oracle === candidate.identity.oracle)
    return rescoreUnderCandidateInstrument(candidate);
  const { pins, oracle, baseline } = migrationEvidence(root, ref, candidate);
  assert.notEqual(candidate.identity.oracle, oracle.identity.oracle, "oracle did not change");
  const { scratch, checkout, targetDir } = await targetCheckout("oracle", []);
  try {
    const { wasm, fixtures } = await buildTarget(checkout, targetDir, oracle.environment.runner);
    const binaryHash = bytesDigest(await readFile(wasm));
    const score = async (label) => {
      const output = resolve(scratch, `${label}.json`);
      await run(process.execPath, ["scripts/bash-compat.mjs"], checkout, {
        BASH_COMPAT_MODE: "frozen",
        BASH_COMPAT_ENGINES: "own-shell",
        BASH_COMPAT_JOBS: "4",
        BASH_COMPAT_TIMEOUT_MS: String(oracle.environment.timeoutMs),
        BASH_COMPAT_SKIP_BUILD: "1",
        BASH_COMPAT_RECORD: "1",
        BASH_COMPAT_SHELL_WASM: wasm,
        ...(fixtures ? { BASH_COMPAT_FIXTURE_DIR: fixtures } : {}),
        BASH_COMPAT_OUT: output,
        BASH_COMPAT_SCRATCH: scratch,
      });
      assert.equal(
        bytesDigest(await readFile(wasm)),
        binaryHash,
        "target binary changed while scoring",
      );
      return JSON.parse(await readFile(output, "utf8"));
    };
    const original = await score("old-oracle");
    validateScore(oracle, original);
    compareScores(baseline, original, { requireMembership: true });
    // Only the copied evidence changes, after the exact source has been built and proven.
    // Running the TARGET scorer both times prevents candidate scorer changes forging target scores.
    await writeFile(resolve(checkout, oraclePath), candidateBytes);
    pins.shellScoreboard.oracleSha256 = bytesDigest(candidateBytes);
    await writeFile(resolve(checkout, "sources.lock.json"), JSON.stringify(pins));
    const corrected = await score("corrected-oracle");
    validateScore(candidate, corrected);
    const counts = (score) =>
      Object.fromEntries(
        Object.entries(summarize(score)).map(([corpus, { categories: _categories, ...value }]) => [
          corpus,
          value,
        ]),
      );
    const before = new Map(original.cases.map((item) => [item.id, item.outcome]));
    console.error(
      `[oracle-migration-proof] ${JSON.stringify({
        baseRef: ref,
        engineSha256: binaryHash,
        oldMembershipProven: true,
        oldCounts: counts(original),
        correctedCounts: counts(corrected),
        scoreChanges: corrected.cases
          .filter((item) => before.get(item.id) !== item.outcome)
          .map((item) => ({ id: item.id, before: before.get(item.id), after: item.outcome })),
      })}`,
    );
    console.error(`Verified target ${ref} under original and corrected oracles`);
    return corrected;
  } finally {
    await cleanupTarget(scratch);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let message;
  try {
    message = { score: await migrate() };
    assert.ok(!interrupted, "target rebuild interrupted");
  } catch (error) {
    message = { error: error.stack ?? String(error) };
    console.error(message.error);
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGTERM", "SIGINT", "disconnect"]) process.off(signal, stop);
  }
  if (process.connected) {
    await new Promise((done) => process.send(message, () => done()));
    if (process.connected) process.disconnect();
  }
}
