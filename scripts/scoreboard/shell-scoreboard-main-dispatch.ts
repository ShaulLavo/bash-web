import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  accumulateFloor,
  bootstrap,
  correctFalsePasses,
  qualification,
} from "./shell-scoreboard-floor.ts";
import {
  authority,
  firstParent,
  fullSha,
  git,
  githubClient,
  oracleAt,
  requestRun,
  scoringInputs,
} from "./shell-scoreboard-main.ts";
import { assertRecord, assertScore, digest } from "./shell-scoreboard.ts";
import type { MainDispatchBinding, RunBinding } from "./shell-scoreboard.ts";

import {
  assertControllerTrust,
  assertMainDispatchRun,
  assertMainAncestry,
  assertMeasured,
  assertPrepared,
  assertRaw,
  assertRawIdentity,
  controllerInputs,
  currentMain,
} from "./shell-scoreboard-main-dispatch-evidence.ts";
import type { Context, PreparedMain, MainRaw } from "./shell-scoreboard-main-dispatch-evidence.ts";
import { mainEvidence, resolveMainFloor } from "./shell-scoreboard-main-evidence.ts";

export async function prepareMainDispatch({
  root,
  measuredRoot,
  client,
  sourceSha,
  executorRef,
  run: binding,
}: Context & {
  measuredRoot: string;
  sourceSha: string;
  executorRef: string;
  run: RunBinding;
}): Promise<PreparedMain> {
  const observedMainSha = await currentMain(root, client);
  assert.equal(
    fullSha(sourceSha),
    observedMainSha,
    "qualification must capture exact current main",
  );
  assertMeasured(measuredRoot, sourceSha);
  const executorSha = git(root, ["rev-parse", "HEAD"]);
  const selected: MainDispatchBinding = {
    kind: "main-dispatch",
    sourceSha,
    beforeSha: firstParent(root, sourceSha),
    executorSha,
    executorRef,
    controllerSha256: digest(controllerInputs(root, executorSha)),
  };
  const run = await requestRun(
    client,
    `/actions/runs/${binding.runId}/attempts/${binding.attempt}`,
  );
  assert.equal(run.id, binding.runId);
  assertMainDispatchRun(root, run, selected, binding.attempt);
  const oracle = oracleAt(root, bootstrap.sourceSha);
  assert.deepEqual(oracleAt(root, sourceSha).identity, oracle.identity, "changed frozen oracle");
  const previous = await resolveMainFloor({ root, sourceSha: selected.beforeSha, client });
  return {
    selected,
    run: binding,
    observedMainSha,
    capturedAt: new Date().toISOString(),
    inputsSha256: digest(scoringInputs(root, sourceSha)),
    floor: correctFalsePasses(oracle, previous.floor),
  };
}
export function sealMainDispatch({
  root,
  measuredRoot,
  prepared,
  score,
}: {
  root: string;
  measuredRoot: string;
  prepared: unknown;
  score: unknown;
}): MainRaw {
  assertPrepared(prepared);
  assertMeasured(measuredRoot, prepared.selected.sourceSha);
  assertControllerTrust(root, prepared.selected);
  assertScore(score);
  const raw: MainRaw = {
    ...prepared,
    schema: 1,
    kind: "main-dispatch-score",
    resultSha256: digest(score),
    score,
  };
  assertRawIdentity(root, oracleAt(root, bootstrap.sourceSha), raw);
  return raw;
}
export async function foldMainDispatch({ root, client, raw: input }: Context & { raw: unknown }) {
  assertRaw(input);
  const raw = input;
  const { selected } = raw;
  const run = await requestRun(
    client,
    `/actions/runs/${raw.run.runId}/attempts/${raw.run.attempt}`,
  );
  assert.equal(run.id, raw.run.runId);
  assertMainDispatchRun(root, run, selected, raw.run.attempt);
  await assertMainAncestry(root, client, selected.sourceSha);
  const oracle = oracleAt(root, bootstrap.sourceSha);
  assertRawIdentity(root, oracle, raw);
  const previous = await resolveMainFloor({ root, sourceSha: selected.beforeSha, client });
  const current = await mainEvidence({ root, oracle, client }).collect(selected.sourceSha);
  const floor = accumulateFloor({
    oracle,
    sourceSha: selected.sourceSha,
    predecessors: [correctFalsePasses(oracle, previous.floor), raw.floor].concat(current.floors),
    scores: current.scores.concat([raw.score]),
    evidence: previous.floor.evidence.concat(current.evidence),
  });
  const result = qualification(oracle, floor, raw.score, selected);
  assert.equal(result.ok, true, "required main passes were lost; no floor published");
  return {
    floor: {
      ...floor,
      run: raw.run,
      beforeSha: selected.beforeSha,
      dispatch: selected,
      lostIds: [],
    },
    qualification: result,
  };
}
function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function assertEnvironment(prepared: PreparedMain): void {
  assert.equal(prepared.run.runId, Number(process.env.GITHUB_RUN_ID));
  assert.equal(prepared.run.attempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(prepared.selected.executorSha, process.env.GITHUB_SHA);
  assert.equal(prepared.selected.executorRef, process.env.GITHUB_REF);
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
}
async function main(): Promise<void> {
  const [command, measuredRoot, directory] = process.argv.slice(2);
  assert.ok(measuredRoot && directory, "requires measured checkout and output directory");
  const root = resolve(import.meta.dirname, "../..");
  mkdirSync(directory, { recursive: true });
  if (command === "seal") {
    const prepared = read(resolve(directory, "input.json"));
    assertPrepared(prepared);
    assertEnvironment(prepared);
    write(
      resolve(directory, "raw.json"),
      sealMainDispatch({
        root,
        measuredRoot,
        prepared,
        score: read(resolve(directory, "score.json")),
      }),
    );
    return;
  }
  const client = githubClient(process.env.GH_TOKEN);
  if (command === "prepare") {
    const event = read(process.env.GITHUB_EVENT_PATH ?? "");
    assertRecord(event);
    assertRecord(event.inputs);
    assert.equal(
      event.repository &&
        typeof event.repository === "object" &&
        "id" in event.repository &&
        event.repository.id,
      authority.repositoryId,
    );
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(git(root, ["rev-parse", "HEAD"]), fullSha(process.env.GITHUB_SHA));
    const prepared = await prepareMainDispatch({
      root,
      measuredRoot,
      client,
      sourceSha: fullSha(event.inputs.main_source),
      executorRef: process.env.GITHUB_REF ?? "",
      run: {
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
    });
    write(resolve(directory, "input.json"), prepared);
    return;
  }
  assert.equal(command, "fold");
  const raw = read(resolve(directory, "raw.json"));
  assertRaw(raw);
  assertEnvironment(raw);
  assertMeasured(measuredRoot, raw.selected.sourceSha);
  const folded = await foldMainDispatch({ root, client, raw });
  write(resolve(directory, "qualification.json"), folded.qualification);
  write(resolve(directory, "floor.json"), folded.floor);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error("Exact main qualification failed:", error);
    process.exitCode = 1;
  });
}
