import { test } from "bun:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPageSuite, writeResult, type SuiteResult } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { finalizeHostDiagnostics } from "./host-diagnostic-delivery.ts";
import { installSessionDrainFixture, sessionDrainAdapter } from "./session-drain.ts";
import { record, selectSessionDrainDiagnostic, sessionDrainIds } from "./session-drain-support.ts";

const primary = "controlled original session drain body failure";
const teardownPrimary = "controlled original session drain disposal failure";

async function artifacts(label: string, run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "drain-results-"));
  try {
    await run(join(directory, "result.json"));
  } finally {
    try {
      await preserveArtifacts(directory, label);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function preserveArtifacts(directory: string, label: string): Promise<void> {
  const destination = process.env.BASH_WEB_DRAIN_RESULTS;
  if (!destination) return;
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(directory))
    await cp(join(directory, file), join(destination, `${label}-${file}`));
}

function confirmedCleanup(result: SuiteResult): void {
  for (const key of ["session", "launcher", "server", "scratch"] as const)
    assert.equal(result.cleanup[key].status, "confirmed", JSON.stringify(result.cleanup));
  assert.equal(result.cleanup.storage.status, "not-created");
  assert.deepEqual(result.ledger, []);
  assert.deepEqual(result.storageRemaining, []);
}

async function field(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function bodyAndTeardown(result: SuiteResult, id: string) {
  const evidence = result.results[id];
  assert.ok(record(evidence) && record(evidence.body) && record(evidence.teardown));
  return { body: evidence.body, teardown: evidence.teardown };
}

for (const engine of ["chromium", "firefox"] as const) {
  test(
    `public ${engine} host runs all original D01 through D12 in fourteen retired documents`,
    () =>
      artifacts(engine, async (path) => {
        const result = await runPageSuite(
          sessionDrainAdapter,
          (scratch) => new PlaywrightDriver(engine, scratch),
          { resultPath: path, scratchRoot: tmpdir() },
        );
        confirmedCleanup(result);
        assert.equal(result.exit, 0, JSON.stringify(result));
        assert.equal(result.runComplete, true);
        assert.deepEqual(result.required, sessionDrainIds);
        assert.deepEqual(result.selected, sessionDrainIds);
        assert.deepEqual(result.omitted, []);
        assert.deepEqual(result.failures, []);
        assert.equal(result.documents.length, 14);
        assert.equal(new Set(result.documents.map((item) => item.doc)).size, 14);
        assert.ok(result.documents.every((item) => item.doc && item.cutoff !== null));
        for (const id of sessionDrainIds)
          assert.deepEqual(result.outcomes[id], { status: "pass", provisional: false });
        const before = await readFile(path, "utf8");
        assert.equal(
          await finalizeHostDiagnostics(path, result.exit, {
            selectDescriptor: selectSessionDrainDiagnostic,
            emit() {
              assert.fail("A passing original suite has no failure diagnostic logs");
            },
          }),
          0,
        );
        assert.equal(await readFile(path, "utf8"), before);
      }),
    180_000,
  );

  test(
    `public ${engine} ordinary failure delivers original diagnostics without replacing primary bytes`,
    () =>
      artifacts(`${engine}-failure`, async (path) => {
        const inventory = sessionDrainAdapter.inventory();
        const first = inventory[0];
        assert.ok(first);
        const adapter = {
          ...sessionDrainAdapter,
          inventory: () =>
            inventory.map((item) => {
              if (item.id === first.id)
                return {
                  ...item,
                  async drive(host: Parameters<typeof installSessionDrainFixture>[0]) {
                    await installSessionDrainFixture(host);
                    throw new Error(primary);
                  },
                };
              if (item.id !== "D02") return item;
              return {
                ...item,
                async drive(host: Parameters<typeof installSessionDrainFixture>[0]) {
                  assert.ok(item.drive);
                  const result = await item.drive(host);
                  await host.task(`const dispose = window.sessionDrain.dispose;
                  window.sessionDrain.dispose = async () => {
                    await dispose();
                    throw new Error(${JSON.stringify(teardownPrimary)});
                  };`);
                  return result;
                },
              };
            }),
        };
        const result = await runPageSuite(
          adapter,
          (scratch) => new PlaywrightDriver(engine, scratch),
          { resultPath: path, scratchRoot: tmpdir() },
        );
        confirmedCleanup(result);
        assert.equal(result.exit, 1, JSON.stringify(result));
        assert.equal(result.runComplete, true);
        assert.deepEqual(result.selected, sessionDrainIds);
        assert.deepEqual(result.omitted, []);
        const failedTeardown = bodyAndTeardown(result, "D02");
        assert.equal(failedTeardown.body.status, "pass");
        assert.equal(failedTeardown.teardown.status, "fail");
        assert.match(String(failedTeardown.teardown.error), new RegExp(teardownPrimary));
        const { body, teardown } = bodyAndTeardown(result, first.id);
        assert.deepEqual(body, { status: "fail", error: `Error: ${primary}` });
        assert.equal(teardown.status, "pass");
        const returned = selectSessionDrainDiagnostic(teardown.result);
        assert.ok(record(returned));
        const diagnostic = {
          name: "browser-startup-diagnostics",
          body: JSON.stringify({ unavailable: true }, null, 2),
          contentType: "application/json",
        };
        const expectedLogs = [
          ["Pending browser startup awaits", "snapshot unavailable"],
          ["Browser startup diagnostics", diagnostic.body],
        ];
        assert.deepEqual(returned, { ...diagnostic, logs: expectedLogs });
        const before = await readFile(path, "utf8");
        const rejectedLogs: string[][] = [];
        const write: typeof writeResult = async (target, source) => {
          if (target.endsWith(".attachments.json"))
            throw new Error("controlled real host attachment rejection");
          await writeResult(target, source);
        };
        assert.equal(
          await finalizeHostDiagnostics(path, result.exit, {
            selectDescriptor: selectSessionDrainDiagnostic,
            write,
            emit: (...args) => rejectedLogs.push(args),
          }),
          1,
        );
        assert.deepEqual(rejectedLogs, expectedLogs);
        assert.match(
          JSON.stringify(await field(`${path}.diagnostic-delivery.json`)),
          /controlled real host attachment rejection/,
        );
        assert.equal(await readFile(path, "utf8"), before);
        await cp(`${path}.diagnostic-delivery.json`, `${path}.rejected-sink.json`);
        const logs: string[][] = [];
        assert.equal(
          await finalizeHostDiagnostics(path, result.exit, {
            selectDescriptor: selectSessionDrainDiagnostic,
            emit: (...args) => logs.push(args),
          }),
          1,
        );
        assert.deepEqual(logs, expectedLogs);
        const receipt = await field(`${path}.diagnostic-delivery.json`);
        assert.ok(record(receipt) && Array.isArray(receipt.cases));
        const failedDelivery = receipt.cases.find(
          (item: unknown) => record(item) && item.caseId === "D02",
        );
        assert.ok(record(failedDelivery));
        assert.equal(failedDelivery.status, "not-returned");
        assert.deepEqual(await field(`${path}.attachments.json`), {
          attachments: [{ caseId: first.id, ...diagnostic }],
        });
        assert.equal(await readFile(path, "utf8"), before);
      }),
    90_000,
  );
}
