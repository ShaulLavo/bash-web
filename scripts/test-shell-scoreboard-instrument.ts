import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  assertInstrumentChanges,
  authorizedInstrumentTransition,
  authorizedRuntimeTransition,
  baselinePath,
  instrumentMigrationEvidence,
  instrumentReceiptPath,
  oraclePath,
  runtimeReceiptPath,
  targetBranchBaseline,
} from "./shell-scoreboard-base.mjs";
import { sealOracle } from "./shell-scoreboard.mjs";

const root = resolve(import.meta.dirname, "..");
const target = authorizedInstrumentTransition.target;
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const candidate = () =>
  JSON.parse(
    execFileSync("git", ["show", `38c229271c851543ce564976e7b09f2971c5e0f8:${oraclePath}`], {
      cwd: root,
      maxBuffer: 1 << 26,
    }).toString(),
  );
const receipt = () => read(instrumentReceiptPath);
const committedBaseline = (revision: string) =>
  JSON.parse(
    execFileSync("git", ["show", `${revision}:${baselinePath}`], {
      cwd: root,
      maxBuffer: 1 << 26,
    }).toString(),
  );

const targetBaseline = () => committedBaseline(target);
const migratedBaseline = () => committedBaseline("38c229271c851543ce564976e7b09f2971c5e0f8");

test("the committed receipt authorizes exactly the recorded target and identity pair", () => {
  const { oracle } = instrumentMigrationEvidence(root, target, candidate());
  assert.equal(oracle.environment.runner, "node:wasi");
  assert.equal(candidate().environment.runner, "waffle-node");
  const recorded = receipt();
  assert.equal(recorded.classification.a + recorded.classification.b, recorded.changes.length);
});

test("the historical real-runtime baseline differs from the target by exactly the receipt", () => {
  assertInstrumentChanges(targetBaseline(), migratedBaseline(), receipt());
});

test("an extra or missing changed case fails the transition proof", () => {
  const extra = migratedBaseline();
  const index = extra.cases.findIndex((item: { outcome: string }) => item.outcome === "pass");
  extra.cases[index] = { ...extra.cases[index], outcome: "fail" };
  assert.throws(
    () => assertInstrumentChanges(targetBaseline(), extra, receipt()),
    /recorded transition/,
  );
  const missing = { ...receipt(), changes: receipt().changes.slice(1) };
  assert.throws(
    () => assertInstrumentChanges(targetBaseline(), migratedBaseline(), missing),
    /recorded transition/,
  );
});

test("any other target ref is rejected, including through the ratchet entry point", async () => {
  const other = "c81f3b57e861835bc6390b32ecfc4544627c1729";
  assert.throws(() => instrumentMigrationEvidence(root, other, candidate()), /authorized only/);
  await assert.rejects(targetBranchBaseline(root, other, candidate()), /authorized only/);
});

test("an unapproved runner or environment change fails closed", () => {
  const changed = candidate();
  changed.environment = { ...changed.environment, runner: "some-other-runner" };
  assert.throws(
    () => instrumentMigrationEvidence(root, target, sealOracle(changed)),
    /candidate environment/,
  );
  const timeout = candidate();
  timeout.environment = { ...timeout.environment, timeoutMs: 20000 };
  assert.throws(
    () => instrumentMigrationEvidence(root, target, sealOracle(timeout)),
    /candidate environment/,
  );
});

test("changed Bash observations, case set, sources or schema fail closed", () => {
  const mutations: Array<(oracle: ReturnType<typeof candidate>) => void> = [
    (oracle) => {
      const item = oracle.cases.find((value: { bash?: unknown }) => value.bash);
      item.bash = { ...item.bash, stdout: Buffer.from("changed").toString("base64") };
    },
    (oracle) => {
      oracle.cases[0] = { ...oracle.cases[0], category: "renamed" };
    },
    (oracle) => {
      oracle.sources = { ...oracle.sources, extra: { revision: "0" } };
    },
  ];
  for (const mutate of mutations) {
    const oracle = candidate();
    mutate(oracle);
    assert.throws(
      () => instrumentMigrationEvidence(root, target, sealOracle(oracle)),
      /unchanged Bash/,
    );
  }
  const schema = sealOracle({ ...candidate(), schema: 2 });
  assert.throws(() => instrumentMigrationEvidence(root, target, schema));
});

test("a receipt naming another transition or omitting a plan item is rejected", () => {
  const cases: Array<[ReturnType<typeof receipt>, RegExp]> = [
    [{ ...receipt(), target: "c81f3b57e861835bc6390b32ecfc4544627c1729" }, /different transition/],
    [
      { ...receipt(), from: { ...receipt().from, environment: "0".repeat(64) } },
      /different transition/,
    ],
    [
      { ...receipt(), to: { ...receipt().to, environment: "0".repeat(64) } },
      /different transition/,
    ],
    [
      {
        ...receipt(),
        changes: receipt().changes.map((change: Record<string, unknown>) =>
          change.class === "a" ? { ...change, plan: undefined } : change,
        ),
      },
      /plan item/,
    ],
  ];
  for (const [recorded, pattern] of cases)
    assert.throws(() => instrumentMigrationEvidence(root, target, candidate(), recorded), pattern);
});

test("the authorized receipt cannot add losses or rewrite its evidence", () => {
  const original = receipt();
  const altered = [
    {
      ...original,
      changes: original.changes.concat([
        { ...original.changes[0], id: "oils:quote:4", change: "lost" },
      ]),
    },
    { ...original, changes: original.changes.slice(1) },
    { ...original, from: { ...original.from, counts: { ...original.from.counts, oils: 0 } } },
    { ...original, classification: { a: 0, b: 16 } },
    {
      ...original,
      changes: original.changes.map((change: Record<string, unknown>, index: number) =>
        index === 0 ? { ...change, reason: "rewritten" } : change,
      ),
    },
  ];
  for (const changed of altered)
    assert.throws(
      () => instrumentMigrationEvidence(root, target, candidate(), changed),
      /authorized receipt/,
    );
});

test("the authorized receipt rejects nonexistent and unrelated plan items", () => {
  const original = receipt();
  for (const plan of [
    "plans/DOES-NOT-EXIST.md#unapproved",
    "plans/004-own-shell.md#follow-up-real-runtime-scoreboard-differences R1",
  ]) {
    const recorded = {
      ...original,
      changes: original.changes.map((change: Record<string, unknown>, index: number) =>
        index === 0 ? { ...change, plan } : change,
      ),
    };
    assert.throws(
      () => instrumentMigrationEvidence(root, target, candidate(), recorded),
      /authorized receipt/,
    );
  }
});

test("the runtime update preserves every target outcome and all Bash observations", () => {
  const oracle = read(oraclePath);
  const { baseline } = instrumentMigrationEvidence(
    root,
    authorizedRuntimeTransition.target,
    oracle,
  );
  assert.equal(oracle.environment.nodeVersion, "v26.12.1");
  assert.equal(oracle.environment.runner, "waffle-node");
  const migrated = {
    identity: oracle.identity,
    cases: committedBaseline(authorizedRuntimeTransition.target).cases,
  };
  assertInstrumentChanges(baseline, migrated, read(runtimeReceiptPath));
});

test("the runtime receipt rejects any gained or lost target case and changed host environment", () => {
  const oracle = read(oraclePath);
  const migrated = {
    identity: oracle.identity,
    cases: committedBaseline(authorizedRuntimeTransition.target).cases,
  };
  const { baseline } = instrumentMigrationEvidence(
    root,
    authorizedRuntimeTransition.target,
    oracle,
  );
  assertInstrumentChanges(baseline, migrated, read(runtimeReceiptPath));
  for (const outcome of ["pass", "fail"]) {
    const changed = structuredClone(migrated);
    const index = changed.cases.findIndex((item: { outcome: string }) => item.outcome === outcome);
    assert.ok(index >= 0);
    changed.cases[index].outcome = outcome === "pass" ? "fail" : "pass";
    assert.throws(
      () => assertInstrumentChanges(baseline, changed, read(runtimeReceiptPath)),
      /recorded transition/,
    );
  }
  oracle.environment.nodeVersion = "v26.12.2";
  assert.throws(
    () => instrumentMigrationEvidence(root, authorizedRuntimeTransition.target, sealOracle(oracle)),
    /candidate environment/,
  );
});
