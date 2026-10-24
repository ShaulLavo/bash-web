import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createWaffleRunner } from "./waffle-compat.ts";
import { liveNodeWorkers } from "./node-worker-host.ts";

import { fixture } from "./own-shell-runner-fixture.ts";

async function runFixture(outputSize) {
  const scratch = await mkdtemp(
    resolve(
      process.env.BASH_COMPAT_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp",
      "bash-web-runner-test-",
    ),
  );
  let worker;
  try {
    const modulePath = resolve(scratch, "fixture.wasm");
    await writeFile(modulePath, fixture(outputSize));
    worker = new Worker(new URL("./bash-compat-worker.mjs", import.meta.url), {
      workerData: {
        engine: "own-shell",
        modulePath,
        scratch,
        home: "/home/user",
        tmp: "/tmp/spec",
        env: {},
      },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("fixture worker timed out")), 5000);
      worker.on("message", (message) => {
        if (message.ready) return worker.postMessage({ id: 1, code: "fixture" });
        clearTimeout(timer);
        done(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
  } finally {
    await worker?.terminate();
    await rm(scratch, { recursive: true, force: true });
    await assert.rejects(access(scratch), { code: "ENOENT" });
  }
}
function assertFixtureResult(result, label) {
  assert.equal(result.crash, undefined, label);
  assert.equal(result.status, 7, label);
  assert.deepEqual(Buffer.from(result.stdout), Buffer.from([255, 0]), label);
  assert.equal(Buffer.from(result.stderr).toString(), "err", label);
}
test("own-shell worker preserves raw stdout, separate stderr and status", async () => {
  assertFixtureResult(await runFixture(2), "worker");
});
test("own-shell worker enforces the combined output ceiling before writing", async () => {
  const result = await runFixture(4 * 1024 * 1024 + 1);
  assert.match(result.crash, /output limit exceeded/);
  assert.equal(result.stdout.length, 0);
});

test("repeated fresh Waffle runtimes leave no threads or handles behind", async () => {
  const scratch = await mkdtemp(resolve(import.meta.dirname, "../.build/own-shell-lifecycle-"));
  try {
    const modulePath = resolve(scratch, "fixture.wasm");
    await writeFile(modulePath, fixture(2));
    const run = await createWaffleRunner({
      modulePath,
      tmp: "/tmp/spec",
      env: {},
      fixtureDirectory: scratch,
    });
    const handles = () => process.getActiveResourcesInfo().length;
    const warm = await run("fixture");
    assert.equal(warm.status, 7);
    const baseline = handles();
    for (let index = 0; index < 25; index++) {
      assertFixtureResult(await run("fixture"), `case ${index}`);
      assert.equal(liveNodeWorkers(), 0, `case ${index} left Waffle threads running`);
    }
    assert.ok(handles() <= baseline, "repeated cases accumulated handles");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
