import assert from "node:assert/strict";
import { waffleBuildFixture, wasiBuildScripts } from "../tests/helpers/waffle-build-inputs.ts";
import { execFileSync, fork, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  authorizedInstrumentTransition,
  authorizedRuntimeTransition,
  baseBranchBaseline,
  runtimeReceiptPath,
  baselinePath,
  instrumentReceiptPath,
  oraclePath,
  targetBranchBaseline,
} from "./shell-scoreboard-base.ts";
import {
  assertOracle,
  assertRecord,
  assertScore,
  bytesDigest,
  compareScores,
  sealOracle,
  validateScore,
} from "./shell-scoreboard.ts";
import type { Oracle, OracleEnvironment, Score } from "./shell-scoreboard.ts";
import { killGroup } from "./shell-process-group.ts";

// Original fake compiler/scorer: no Cargo, WASI execution, network, or installed dependencies.
const cargoFixture = `#!${process.execPath}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const target = process.env.CARGO_TARGET_DIR;
if (existsSync(target)) throw Error('reused build artifacts');
if (process.env.RUSTC_WRAPPER || process.env.RUSTFLAGS) throw Error('compiler environment leaked');
const source = readFileSync('shell/source.json');
mkdirSync(resolve(target, 'wasm32-wasip1/release'), { recursive: true });
const integer = (value) => {
  const bytes = [];
  do { const part = value & 127; value >>>= 7; bytes.push(part | (value ? 128 : 0)); } while (value);
  return bytes;
};
// Genuine minimal Wasm keeps verification real while the compiler is a stand-in.
const memory = [1, 1, 1].concat(integer(JSON.parse(source).invalidArtifact ? 65536 : 4096));
const payload = Buffer.concat([Buffer.from([7]), Buffer.from('fixture'), source]);
const names = process.argv.includes('shell-runtime')
  ? ['shell-runtime', 'argv-py', 'printenv-py']
  : ['shell-engine'];
const bytes = Buffer.concat([
  Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 5].concat(integer(memory.length), memory)),
  Buffer.from([0].concat(integer(payload.length))), payload,
]);
for (const name of names) writeFileSync(resolve(target, 'wasm32-wasip1/release', name + '.wasm'), bytes);
if (JSON.parse(source).buildFail) throw Error('fake build failure');
if (JSON.parse(source).hang) {
  const marker = resolve(target, '../started');
  if (JSON.parse(source).descendant) {
    const script = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" +
      JSON.stringify(marker) + ",String(process.pid));setInterval(()=>{},1000)";
    spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  } else {
    process.on('SIGTERM', () => {});
    writeFileSync(marker, String(process.pid));
  }
  setInterval(() => {}, 1000);
}
`;
const npmFixture = `#!${process.execPath}
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
assert.equal(process.argv[2], 'ci');
assert.equal(process.argv[3], '--ignore-scripts');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const pinned = lock.packages[''].dependencies.waffle;
mkdirSync(resolve('node_modules/waffle'), { recursive: true });
writeFileSync(resolve('node_modules/waffle/content.txt'), pinned);
assert.equal(process.env.NPM_CONFIG_CACHE, process.env.RUNNER_TEMP + '/shared-npm-cache');
`;
const scorerFixture = `
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
assert.equal(process.env.BASH_COMPAT_RECORD, '1');
assert.equal(process.env.BASH_COMPAT_BASE_REF, undefined, 'recursive base validation');
assert.equal(process.env.BASH_COMPAT_SKIP_BUILD, '1');
const oracle = JSON.parse(readFileSync('${oraclePath}'));
assert.equal(process.env.BASH_COMPAT_TIMEOUT_MS, String(oracle.environment.timeoutMs));
const module = new WebAssembly.Module(readFileSync(process.env.BASH_COMPAT_SHELL_WASM));
const actual = JSON.parse(Buffer.from(WebAssembly.Module.customSections(module, 'fixture')[0]));
if (existsSync('harness-observed.txt')) assert.equal(readFileSync('harness-observed.txt', 'utf8'), 'target-pinned');
if (actual.invalidArtifact) writeFileSync(process.env.WASI_SDK_PATH + '/../scorer-ran', 'unexpected scoring');
if (actual.scoreFail && oracle.oracle.capture === 'corrected') throw Error('fake scorer failure');
writeFileSync(process.env.BASH_COMPAT_OUT, JSON.stringify({
  identity: oracle.identity,
  cases: oracle.cases.map(({ id, corpus, category, kind, bash }) => ({
    id, corpus, category, kind,
    outcome: bash.stdout === actual.stdout ? 'pass' : 'fail',
  })),
}));
`;
function makeOracle(
  environment: OracleEnvironment = { nodeVersion: "v26.12.1", stdin: "empty", timeoutMs: 10000 },
): Oracle {
  return sealOracle({
    schema: 1,
    oracle: { capture: "old" },
    environment,
    sources: {
      oils: { revision: "fixture" },
      "brush-suite": { revision: "fixture" },
      "bashkit-suite": { revision: "fixture" },
    },
    cases: ["YQ==", "Yg=="].map((stdout, index) => ({
      id: `oils:${index}`,
      corpus: "oils",
      file: "fixture.spec.ts",
      line: index + 1,
      name: `fixture ${index}`,
      category: "fixture",
      kind: "builtins-only",
      code: "printf a",
      bash: { status: 0, stdout, stderr: "" },
    })),
  });
}
function score(oracle: Oracle, outcomes: string[] = ["pass", "fail"]): Score {
  return {
    identity: oracle.identity,
    cases: oracle.cases.map(({ id, corpus, category, kind }, index) => ({
      id,
      corpus,
      category,
      kind,
      outcome: outcomes[index],
    })),
  };
}
function currentOracleEnvironment(): OracleEnvironment {
  const oracle: unknown = JSON.parse(
    readFileSync(new URL(`../${oraclePath}`, import.meta.url), "utf8"),
  );
  assertOracle(oracle);
  return oracle.environment;
}
function directChildren() {
  const ids = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim();
  return new Map(
    ids
      ? ids
          .split(/\s+/)
          .map(Number)
          .map((pid) => [pid, processState(pid).start])
      : [],
  );
}
function signalChild(pid: number): void {
  if (!processState(pid).active) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH")
      throw error;
  }
}
function admitChildren(
  preexisting: Map<number, string | undefined>,
  owned: Map<number, string | undefined>,
): void {
  for (const [pid, start] of directChildren()) {
    if (preexisting.get(pid) === start || owned.has(pid)) continue;
    owned.set(pid, start);
    signalChild(pid);
  }
}
function restoreEnvironment(saved: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) delete process.env[name];
  }
  Object.assign(process.env, saved);
}
interface FixtureOwner {
  scratch?: string;
  close: () => Promise<void>;
}
function fixtureOwner(): FixtureOwner {
  const preexisting = directChildren();
  const owner: FixtureOwner = { scratch: undefined, close: async () => {} };
  let teardown: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (teardown ??= (async () => {
      const owned = new Map<number, string | undefined>();
      const deadline = Date.now() + 15000;
      for (;;) {
        admitChildren(preexisting, owned);
        const live = Array.from(owned, ([pid, start]) => {
          const current = processState(pid);
          return current.active && current.start === start;
        });
        if (!live.some(Boolean)) break;
        assert.ok(
          Date.now() < deadline,
          `fixture children remain; scratch retained at ${owner.scratch}`,
        );
        await delay(20);
      }
      if (owner.scratch) rmSync(owner.scratch, { recursive: true, force: true });
    })());
  const term = () => {
    void cleanup().then(
      () => process.exit(143),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  const int = () => {
    void cleanup().then(
      () => process.exit(130),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", int);
  owner.close = async () => {
    try {
      await cleanup();
    } finally {
      process.off("SIGTERM", term);
      process.off("SIGINT", int);
    }
  };
  return owner;
}
interface FixtureContext {
  repo: string;
  ref: string;
  next: Oracle;
  old: Oracle;
  runner: string;
  put: (path: string, contents: string | Buffer) => void;
  update: (oracle: Oracle) => void;
}
interface FixtureOptions {
  wrongBaseline?: boolean;
  badChecksum?: boolean;
  hang?: boolean;
  descendant?: boolean;
  buildFail?: boolean;
  invalidArtifact?: boolean;
  scoreFail?: boolean;
  entrypoint?: boolean;
  targetRunner?: string;
  tarMode?: "fail" | "hang";
}
async function fixture(
  run: (context: FixtureContext) => Promise<void>,
  {
    wrongBaseline = false,
    badChecksum = false,
    hang = false,
    descendant = false,
    buildFail = false,
    invalidArtifact = false,
    scoreFail = false,
    entrypoint = false,
    targetRunner = undefined,
    tarMode = undefined,
  }: FixtureOptions = {},
): Promise<void> {
  const owner = fixtureOwner(); // Teardown and the pre-existing child inventory precede setup.
  const saved = { ...process.env };
  try {
    const scratchRoot = process.env.RUNNER_TEMP ?? "/work/tmp/bash-web-climb-subst";
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(resolve(scratchRoot, "audit-migration-test-"));
    owner.scratch = scratch;
    const repo = resolve(scratch, "repo");
    const runner = resolve(scratch, "runner");
    const bin = resolve(scratch, "bin");
    for (const directory of [repo, runner, bin]) mkdirSync(directory);
    const put = (path: string, contents: string | Buffer): void => {
      mkdirSync(dirname(resolve(repo, path)), { recursive: true });
      writeFileSync(resolve(repo, path), contents);
    };
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const old = makeOracle(
      entrypoint
        ? currentOracleEnvironment()
        : targetRunner
          ? { nodeVersion: "v26.12.1", stdin: "empty", timeoutMs: 10000, runner: targetRunner }
          : undefined,
    );
    const sourcePins = {
      oils: { revision: "fixture" },
      brush: { revision: "fixture" },
      bashkitTerminal: { revision: "fixture" },
      waffle: waffleBuildFixture(
        repo,
        `#!/bin/bash
set -eu
mkdir -p "$1/lib/wasm32-wasip1"
printf fixture > "$1/lib/wasm32-wasip1/libc.a"
`,
        "fixture patch",
      ),
    };
    put(oraclePath, JSON.stringify(old));
    put(baselinePath, JSON.stringify(score(old, wrongBaseline ? ["fail", "pass"] : undefined)));
    if (targetRunner === "waffle-node") {
      put(
        "package-lock.json",
        JSON.stringify({
          name: "fixture",
          lockfileVersion: 3,
          packages: { "": { dependencies: { waffle: "target-pinned" } } },
        }),
      );
      put(
        "scripts/build-node-harness.ts",
        "import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('harness-observed.txt', readFileSync('node_modules/waffle/content.txt', 'utf8'));\n",
      );
    }
    put(
      "sources.lock.json",
      JSON.stringify({
        ...sourcePins,
        shellScoreboard: {
          oracleSha256: badChecksum ? "wrong" : bytesDigest(Buffer.from(JSON.stringify(old))),
        },
      }),
    );
    put(
      "shell/source.json",
      JSON.stringify({ stdout: "YQ==", hang, descendant, buildFail, invalidArtifact, scoreFail }),
    );
    put("scripts/bash-compat.mjs", scorerFixture);
    git(["init", "-q"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const ref = git(["rev-parse", "HEAD"]);
    if (targetRunner === "waffle-node") {
      put(
        "package-lock.json",
        JSON.stringify({
          name: "fixture",
          lockfileVersion: 3,
          packages: { "": { dependencies: { waffle: "candidate-pinned" } } },
        }),
      );
      put("node_modules/waffle/content.txt", "candidate-pinned");
    }
    if (tarMode) {
      writeFileSync(
        resolve(bin, "tar"),
        `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nconst mode = ${JSON.stringify(tarMode)};\nif (mode === 'fail') throw Error('fake archive extraction failure');\nwriteFileSync('setup-started', String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
      );
      chmodSync(resolve(bin, "tar"), 0o755);
    }
    if (targetRunner === "waffle-node") {
      writeFileSync(resolve(bin, "npm"), npmFixture);
      chmodSync(resolve(bin, "npm"), 0o755);
    }
    const candidate = structuredClone(old);
    assertRecord(candidate.oracle);
    candidate.oracle.capture = "corrected";
    const firstBash = candidate.cases[0].bash;
    const secondBash = candidate.cases[1].bash;
    assert.ok(firstBash && secondBash);
    firstBash.stdout = "eg==";
    secondBash.stdout = "YQ==";
    const next = sealOracle(candidate);
    const update = (oracle: Oracle): void => {
      put(oraclePath, JSON.stringify(oracle));
      put(
        "sources.lock.json",
        JSON.stringify({
          ...sourcePins,
          shellScoreboard: { oracleSha256: bytesDigest(Buffer.from(JSON.stringify(oracle))) },
        }),
      );
    };
    update(next);
    put(baselinePath, JSON.stringify(score(next, ["fail", "fail"])));
    // Neither uncommitted sources, a prebuilt artifact, nor candidate scorer may supply base evidence.
    put("shell/source.json", '{"stdout":"eg=="}');
    put(".build/shell/wasm32-wasip1/release/shell-engine.wasm", '{"stdout":"eg=="}');
    put(
      "scripts/bash-compat.mjs",
      'throw Error("candidate scorer must not collect target evidence");',
    );
    // The libc compiler is also a stand-in, but the shared link recipe is real.
    put("sdk/VERSION", "34.0\nwasi-libc: 2e6fb9d8ee0c\n");
    process.env.WASI_SDK_PATH = resolve(repo, "sdk");
    writeFileSync(resolve(bin, "cargo"), cargoFixture);
    chmodSync(resolve(bin, "cargo"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.RUNNER_TEMP = runner;
    process.env.NPM_CONFIG_CACHE = resolve(runner, "shared-npm-cache");
    process.env.CARGO_TARGET_DIR = resolve(repo, ".build/shell");
    process.env.RUSTC_WRAPPER = "candidate-wrapper-must-not-run";
    process.env.RUSTFLAGS = "candidate-flags-must-not-apply";
    process.env.BASH_COMPAT_BASE_REF = ref;
    process.env.BASH_COMPAT_RECORD = "0";
    for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_ORACLE", "BASH_COMPAT_BASELINE"])
      delete process.env[name];
    await run({ repo, ref, next, old, runner, put, update });
    assert.deepEqual(readdirSync(runner), [], "migration scratch leaked");
    assert.equal(process.env.BASH_COMPAT_BASE_REF, ref);
    assert.equal(process.env.BASH_COMPAT_RECORD, "0");
  } finally {
    try {
      await owner.close();
      if (owner.scratch) assert.equal(existsSync(owner.scratch), false);
    } finally {
      restoreEnvironment(saved);
    }
  }
}

test("migration rebuilds immutable target and lowered candidate baseline cannot conceal regression", async () => {
  await fixture(async ({ repo, ref, next }) => {
    const target = await targetBranchBaseline(repo, ref, next);
    assert.ok(target);
    assert.deepEqual(
      target.cases.map((item) => item.outcome),
      ["fail", "pass"],
    );
    validateScore(next, target);
    const lowered = score(next, ["fail", "fail"]);
    compareScores(lowered, lowered, { requireMembership: true });
    assert.equal(compareScores(target, lowered).ok, false);
  });
});

test("migration launcher excludes inherited Node startup hooks", async () => {
  await fixture(async ({ repo, ref, next, put }) => {
    const marker = resolve(repo, "preload-ran");
    const preload = resolve(repo, "preload.cjs");
    put("preload.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
    const args = process.execArgv.slice();
    try {
      process.env.NODE_OPTIONS = `--require=${preload}`;
      process.execArgv.push("--require", preload);
      const target = await targetBranchBaseline(repo, ref, next);
      assert.ok(target);
      assert.deepEqual(
        target.cases.map((item) => item.outcome),
        ["fail", "pass"],
      );
      assert.equal(existsSync(marker), false, "launcher ran an inherited startup hook");
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...args);
    }
  });
});

test("migration rejects incorrect immutable baseline membership", async () => {
  await fixture(
    async ({ repo, ref, next }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /stale candidate baseline/);
    },
    { wrongBaseline: true },
  );
});

test("migration rejects a freshly built artifact with the wrong memory cap before scoring", async () => {
  await fixture(
    async ({ repo, ref }) => {
      const candidate: unknown = JSON.parse(readFileSync(resolve(repo, oraclePath), "utf8"));
      assertOracle(candidate);
      await assert.rejects(targetBranchBaseline(repo, ref, candidate), /failed \(1\)/);
      assert.equal(
        existsSync(resolve(repo, "scorer-ran")),
        false,
        "scorer ran before artifact validation",
      );
    },
    { invalidArtifact: true },
  );
});

test("failed build and corrected scoring both clean their private resources", async () => {
  for (const options of [{ buildFail: true }, { scoreFail: true }]) {
    await fixture(async ({ repo, ref, next }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /failed/);
    }, options);
  }
});

test("migration verifies the immutable oracle checksum", async () => {
  await fixture(
    async ({ repo, ref, next }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /target oracle checksum/);
    },
    { badChecksum: true },
  );
});

test("migration rejects case, environment, source and schema changes", async () => {
  await fixture(async ({ repo, ref, next }) => {
    for (const mutate of [
      (o) => {
        o.cases[0].code = "printf b";
      },
      (o) => {
        o.cases[0].category = "new";
      },
      (o) => {
        o.cases[0].excluded = "skip";
      },
      (o) => {
        o.cases.reverse();
      },
      (o) => {
        o.environment.stdin = "changed";
      },
      (o) => {
        assertRecord(o.sources.oils);
        o.sources.oils.revision = "changed";
      },
      (o) => {
        o.schema = 2;
      },
    ] satisfies ((oracle: Oracle) => void)[]) {
      const changed = structuredClone(next);
      mutate(changed);
      await assert.rejects(
        targetBranchBaseline(repo, ref, sealOracle(changed)),
        /unchanged|schema/,
      );
    }
  });
});

test("migration rejects invalid base refs and supplied artifacts or baseline paths", async () => {
  await fixture(async ({ repo, ref, next }) => {
    for (const invalid of ["HEAD", ref.slice(0, 12), "a".repeat(40), `${ref}:shell`, "--help"])
      await assert.rejects(targetBranchBaseline(repo, invalid, next));
    await assert.rejects(
      Reflect.apply(targetBranchBaseline, undefined, [repo, ref, next, { wasm: "supplied.wasm" }]),
      /no supplied artifacts/,
    );
    for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_ORACLE", "BASH_COMPAT_BASELINE"]) {
      process.env[name] = "supplied";
      await assert.rejects(targetBranchBaseline(repo, ref, next), /rejects supplied/);
      delete process.env[name];
    }
  });
});

test("unchanged oracle preserves original target ratchet without rebuilding", async () => {
  await fixture(async ({ repo, ref, old, update }) => {
    update(old);
    const baseline = await targetBranchBaseline(repo, ref, old);
    assert.deepEqual(baseline, score(old));
  });
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for fixture");
    await delay(20);
  }
}

function processState(pid: number): { active: boolean; start?: string } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { active: !["Z", "X"].includes(fields[0]), start: fields[19] };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error)) throw error;
    if (error.code === "ENOENT" || error.code === "ESRCH") return { active: false };
    throw error;
  }
}
function readProcessMarker(marker: string): { pid: number; start: string | undefined } {
  const pid = Number(readFileSync(marker, "utf8"));
  return { pid, start: processState(pid).start };
}
async function killOwnedProcess(pid: number | undefined, start: string | undefined): Promise<void> {
  if (!pid || processState(pid).start !== start || !processState(pid).active) return;
  process.kill(pid, "SIGKILL");
  await until(() => !processState(pid).active);
}
for (const descendant of [false, true]) {
  for (const cancellation of ["TERM", "parent disconnect"]) {
    test(`${cancellation} stops ${descendant ? "descendant after leader exit" : "child"} before removing scratch`, async () => {
      await fixture(
        async ({ repo, ref, runner }) => {
          const launcher = fileURLToPath(
            new URL("./shell-scoreboard-migration.ts", import.meta.url),
          );
          const child =
            cancellation === "TERM"
              ? spawn(process.execPath, [launcher, repo, ref], { stdio: "ignore" })
              : fork(launcher, [repo, ref], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
          const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
          let pid: number | undefined;
          let start: string | undefined;
          try {
            await until(() => {
              const scratch = readdirSync(runner)[0];
              const marker = scratch && resolve(runner, scratch, "started");
              if (!marker || !existsSync(marker)) return false;
              ({ pid, start } = readProcessMarker(marker));
              return start !== undefined;
            });
            assert.ok(pid);
            if (cancellation === "TERM") child.kill("SIGTERM");
            else child.disconnect();
            await exited;
            assert.equal(
              processState(pid).active,
              false,
              "live consumer survived launcher cleanup",
            );
            assert.deepEqual(readdirSync(runner), []);
          } finally {
            child.kill("SIGTERM");
            await exited;
            // Emergency fixture teardown also owns the grandchild if an assertion exposes a bug.
            await killOwnedProcess(pid, start);
          }
        },
        { hang: true, descendant },
      );
    });
  }
}

function putCompatibilityEntrypoint(put: FixtureContext["put"]): void {
  // Only the compiler and archived target scorer are stand-ins. The candidate entrypoint,
  // trusted baseline launcher, migration supervisor and group draining are shipped code.
  const entrypointScripts = [
    "bash-compat.ts",
    "compat-programs.ts",
    "bash-compat-helpers.ts",
    "bash-compat-runner.ts",
    "shell-scoreboard.ts",
    "shell-scoreboard-base.ts",
    "shell-scoreboard-migration.ts",
    "shell-process-group.ts",
  ];
  for (const name of entrypointScripts.concat(wasiBuildScripts))
    put(`scripts/${name}`, readFileSync(new URL(name, import.meta.url)));
}
function runCompatibility(repo: string, runner: string) {
  return spawnSync(process.execPath, [resolve(repo, "scripts/bash-compat.ts")], {
    env: {
      ...process.env,
      BASH_COMPAT_MODE: "frozen",
      BASH_COMPAT_ENGINES: "own-shell",
      BASH_COMPAT_SCRATCH: runner,
      BASH_COMPAT_TIMEOUT_MS: "10000",
      BASH_COMPAT_BASE_REF: "HEAD",
      BASH_COMPAT_RECORD: "0",
      BASH_COMPAT_SKIP_BUILD: "1",
    },
    encoding: "utf8",
  });
}
const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
for (const signal of signals) {
  test(`${signal} on the compatibility entrypoint awaits its active migration`, async () => {
    await fixture(
      async ({ repo, runner, put }) => {
        putCompatibilityEntrypoint(put);
        const child = spawn(process.execPath, [resolve(repo, "scripts/bash-compat.ts")], {
          env: {
            ...process.env,
            BASH_COMPAT_MODE: "frozen",
            BASH_COMPAT_SCRATCH: runner,
            BASH_COMPAT_TIMEOUT_MS: "10000",
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        const errors: Buffer[] = [];
        child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
        const exited = new Promise<number | null>((accept) =>
          child.once("close", (code) => accept(code)),
        );
        // This independent watchdog also releases the launcher's IPC parent-death cleanup
        // if the old, uncancellable entrypoint is used as a negative control.
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000).unref();
        let pid: number | undefined;
        let start: string | undefined;
        try {
          let directory: string | undefined;
          await until(() => {
            assert.equal(
              child.exitCode ?? child.signalCode,
              null,
              `compatibility entrypoint exited before migration started:
${Buffer.concat(errors)}`,
            );
            directory = readdirSync(runner).find((name) =>
              name.startsWith("audit-oracle-migration-"),
            );
            const marker = directory && resolve(runner, directory, "started");
            if (!marker || !existsSync(marker)) return false;
            pid = Number(readFileSync(marker, "utf8"));
            start = processState(pid).start;
            return start !== undefined;
          });
          assert.ok(pid && directory);
          child.kill(signal);
          await delay(50);
          assert.equal(child.exitCode, null, "entrypoint exited before its compiler stopped");
          assert.equal(existsSync(resolve(runner, directory)), true);
          const status = await exited;
          assert.equal(status, signal === "SIGTERM" ? 143 : 130, Buffer.concat(errors).toString());
          assert.equal(
            processState(pid).active,
            false,
            "compiler outlived entrypoint cancellation",
          );
          assert.deepEqual(readdirSync(runner), []);
        } finally {
          child.kill("SIGTERM");
          await exited;
          clearTimeout(watchdog);
          await killOwnedProcess(pid, start);
          // Even a watchdog failure must await the orphan launcher's IPC-disconnect cleanup
          // before the outer fixture removes its files. The entrypoint's own scratch is ours.
          await until(
            () => !readdirSync(runner).some((name) => name.startsWith("audit-oracle-migration-")),
          );
        }
      },
      { hang: true, entrypoint: true },
    );
  });
}

test("frozen validation skips non-runnable missing observations but rejects eligible ones", async () => {
  for (const eligible of [false, true]) {
    await fixture(
      async ({ repo, runner, put, update, next }) => {
        putCompatibilityEntrypoint(put);
        const changed = structuredClone(next.cases[0]);
        delete changed.bash;
        if (!eligible) changed.kind = "needs-commands";
        update(sealOracle({ ...next, cases: [changed] }));
        const result = runCompatibility(repo, runner);
        assert.notEqual(result.status, 0);
        if (eligible) {
          assert.match(result.stderr, /invalid oracle status/);
          return;
        }
        assert.doesNotMatch(result.stderr, /Missing oracle observation/);
        assert.match(result.stderr, /BASH_COMPAT_BASE_REF must be a full commit SHA/);
      },
      { entrypoint: true },
    );
  }
});

test("archive setup failure removes scratch acquired before extraction", async () => {
  await fixture(
    async ({ repo, ref, next, runner }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /tar failed/);
      assert.deepEqual(readdirSync(runner), []);
    },
    { tarMode: "fail" },
  );
});

function setupConsumer(
  runner: string,
): { directory: string; pid: number; start: string } | undefined {
  const directory = readdirSync(runner).find((name) => name.startsWith("audit-oracle-migration-"));
  if (!directory) return;
  const marker = resolve(runner, directory, "setup-started");
  if (!existsSync(marker)) return;
  const pid = Number(readFileSync(marker, "utf8"));
  const start = processState(pid).start;
  if (!start) return;
  return { directory, pid, start };
}

async function cleanupSetupConsumer(consumer: ReturnType<typeof setupConsumer>): Promise<void> {
  if (!consumer || processState(consumer.pid).start !== consumer.start) return;
  killGroup(consumer.pid, "SIGKILL");
  await until(() => !processState(consumer.pid).active);
}

async function interruptSetup(
  { repo, ref, runner }: Pick<FixtureContext, "repo" | "ref" | "runner">,
  cancellation: string,
): Promise<void> {
  const launcher = fileURLToPath(new URL("./shell-scoreboard-migration.ts", import.meta.url));
  const child = fork(launcher, [repo, ref], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000).unref();
  let consumer: ReturnType<typeof setupConsumer>;
  try {
    await until(() => {
      consumer = setupConsumer(runner);
      return consumer !== undefined;
    });
    assert.ok(consumer);
    if (cancellation === "TERM") child.kill("SIGTERM");
    else child.disconnect();
    await delay(50);
    assert.equal(child.exitCode, null, "launcher exited before extraction stopped");
    assert.equal(existsSync(resolve(runner, consumer.directory)), true);
    await exited;
    assert.equal(processState(consumer.pid).active, false, "extractor outlived launcher");
    assert.deepEqual(readdirSync(runner), []);
  } finally {
    child.kill("SIGTERM");
    await exited;
    clearTimeout(watchdog);
    await cleanupSetupConsumer(consumer);
  }
}

for (const cancellation of ["TERM", "parent disconnect"]) {
  test(`${cancellation} during archive setup drains its consumer and removes scratch`, async () => {
    await fixture((context) => interruptSetup(context, cancellation), { tarMode: "hang" });
  });
}

test("waffle target migration installs target-pinned dependencies in target scratch", async () => {
  await fixture(
    async ({ repo, ref, next }) => {
      const result = await targetBranchBaseline(repo, ref, next);
      assert.ok(result);
      assert.deepEqual(
        result.cases.map((item) => item.outcome),
        ["fail", "pass"],
      );
      assert.equal(
        readFileSync(resolve(repo, "node_modules/waffle/content.txt"), "utf8"),
        "candidate-pinned",
      );
    },
    { targetRunner: "waffle-node" },
  );
});

function linkRepositoryHistory(put: FixtureContext["put"]): string {
  const root = resolve(import.meta.dirname, "..");
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  put(".git/objects/info/alternates", `${resolve(root, common, "objects")}\n`);
  return root;
}

test("instrument migration prepares a cold patched sysroot before its first cargo build", async () => {
  await fixture(async ({ repo, runner, put, update }) => {
    const root = linkRepositoryHistory(put);
    const candidate: unknown = JSON.parse(
      execFileSync("git", ["show", `38c229271c851543ce564976e7b09f2971c5e0f8:${oraclePath}`], {
        cwd: root,
        maxBuffer: 1 << 26,
      }).toString(),
    );
    assertOracle(candidate);
    update(candidate);
    put(instrumentReceiptPath, readFileSync(resolve(root, instrumentReceiptPath)));
    const proof = resolve(repo, "cold-build-proof");
    const compiler = resolve(runner, "../bin/cargo");
    writeFileSync(
      compiler,
      `#!${process.execPath}
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const sysroot = process.env.CFLAGS_wasm32_wasip1.split('--sysroot=')[1];
assert.ok(existsSync(resolve(sysroot, 'lib/wasm32-wasip1/libc.a')), 'cold libc not prepared');
assert.match(readFileSync(resolve(sysroot, '../recipe.sha256'), 'utf8'), /^[a-f0-9]{64}$/);
writeFileSync(${JSON.stringify(proof)}, sysroot);
process.exit(21);
`,
    );
    assert.equal(existsSync(resolve(repo, ".build/wasi-libc")), false);
    await assert.rejects(
      targetBranchBaseline(repo, authorizedInstrumentTransition.target, candidate),
      /cargo failed \(21\)/,
    );
    assert.ok(readFileSync(proof, "utf8").startsWith(resolve(repo, ".build/wasi-libc")));
    assert.deepEqual(readdirSync(runner), []);
  });
});

test("runtime migration builds and supplies immutable target utility guests", async () => {
  await fixture(async ({ repo, runner, put, update }) => {
    const root = linkRepositoryHistory(put);
    const candidate: unknown = JSON.parse(readFileSync(resolve(root, oraclePath), "utf8"));
    assertOracle(candidate);
    update(candidate);
    put(runtimeReceiptPath, readFileSync(resolve(root, runtimeReceiptPath)));
    put(baselinePath, readFileSync(resolve(root, baselinePath)));
    const targetBaseline = baseBranchBaseline(root, authorizedRuntimeTransition.target);
    assert.ok(targetBaseline);
    const migratedTarget = {
      identity: candidate.identity,
      cases: targetBaseline.cases,
    };
    put("fixture-target-score.json", JSON.stringify(migratedTarget));
    put("scripts/build-node-harness.ts", "");
    const compiler = resolve(runner, "../bin/cargo");
    writeFileSync(
      compiler,
      `#!${process.execPath}
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const release = resolve(process.env.CARGO_TARGET_DIR, 'wasm32-wasip1/release');
mkdirSync(release, { recursive: true });
const names = process.argv.includes('shell-utilities')
  ? ['shell-runtime', 'cat', 'grep', 'mkdir', 'seq']
  : ['argv-py', 'printenv-py'];
if (process.cwd() !== ${JSON.stringify(repo)}) {
  assert.match(readFileSync('shell/utilities/Cargo.toml', 'utf8'), /name = "shell-utilities"/);
  const binaries = process.argv.filter((_, index, args) => args[index - 1] === '--bin');
  assert.deepEqual(binaries, names, 'request only immutable target binaries');
}
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 1, 1, 1, 128, 32]);
for (const name of names) writeFileSync(resolve(release, name + '.wasm'), wasm);
`,
    );
    put(
      "scripts/bash-compat.ts",
      `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const release = dirname(process.env.BASH_COMPAT_SHELL_WASM);
assert.equal(process.env.BASH_COMPAT_UTILITY_DIR, release);
for (const name of ['cat', 'grep', 'mkdir', 'seq'])
  assert.ok(readFileSync(resolve(release, name + '.wasm')).length > 0);
writeFileSync(process.env.BASH_COMPAT_OUT, readFileSync('fixture-target-score.json'));
`,
    );
    const result = await targetBranchBaseline(repo, authorizedRuntimeTransition.target, candidate);
    assert.ok(result);
    assert.deepEqual(result, migratedTarget);
    const candidateScore: unknown = JSON.parse(readFileSync(resolve(repo, baselinePath), "utf8"));
    assertScore(candidateScore);
    const delta = compareScores(result, candidateScore);
    assert.equal(delta.ok, true);
    assert.ok(
      Object.values(delta.corpora).some((row) => row.gained.length > 0),
      "later candidate gains remain separate from target evidence",
    );
    const passing = result.cases.find((item) => item.outcome === "pass");
    const failing = result.cases.find((item) => item.outcome === "fail");
    assert.ok(passing && failing);
    for (const mutations of [
      { [passing.id]: "fail" },
      { [failing.id]: "pass" },
      { [passing.id]: "fail", [failing.id]: "pass" },
    ] satisfies Record<string, string>[]) {
      const changed = {
        ...migratedTarget,
        cases: migratedTarget.cases.map((item) => ({
          ...item,
          outcome: mutations[item.id] ?? item.outcome,
        })),
      };
      put("fixture-target-score.json", JSON.stringify(changed));
      await assert.rejects(
        targetBranchBaseline(repo, authorizedRuntimeTransition.target, candidate),
        /recorded transition/,
      );
    }
    const changedIdentity = {
      ...migratedTarget,
      identity: { ...migratedTarget.identity, environment: "wrong" },
    };
    put("fixture-target-score.json", JSON.stringify(changedIdentity));
    await assert.rejects(
      targetBranchBaseline(repo, authorizedRuntimeTransition.target, candidate),
      /incomparable/,
    );
    assert.deepEqual(readdirSync(runner), []);
  });
});
