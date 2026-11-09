import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { HostCase } from "waffle/testing/page-runner";
import { checkPromptHookResult, recordPromptHookCosts } from "../helpers/prompt-hook-assertions.ts";
import { promptHookBody, promptHookCostsBody } from "../helpers/prompt-hook-fixture.ts";
import {
  createPromptHookAdapter,
  drivePromptHook,
  promptHookModuleTask,
} from "./prompt-hook-adapter.ts";
import { promptHookCases } from "./prompt-hook-contract.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, start);
  const stop = source.indexOf(end, at + start.length);
  assert.ok(stop > at, end);
  return source.slice(at, stop);
}

test("complete original helpers, H01, H02, compilation and assertions retain byte parity", async () => {
  const fixture = await readFile("tests/helpers/prompt-hook-fixture.ts", "utf8");
  assert.equal(
    digest(between(fixture, "const helpers = `", "\n\nexport const promptHookBody")),
    "3f51f8ab3353b44f04aedb80bbb8f8bb6e4957d7f1479f6dd006d50126657784",
  );
  const functional = between(fixture, "export const promptHookBody = ", ";\n\nexport type").slice(
    "export const promptHookBody = ".length,
  );
  assert.equal(
    digest(functional),
    "e704725543a312744d87a26ffbe687b8dad8ccfc76ac0e8bb62f4187ddebf7db",
  );
  const costs = between(
    fixture,
    "  return `\nconst samples",
    ";\n}\n\nexport async function compilePromptHookProof",
  ).slice("  return ".length);
  assert.equal(costs.split("${name}").length, 2);
  assert.equal(
    digest(costs.replace("${name}", '"prompt-costs-" + Date.now()')),
    "bab2a73ec3249e2be3b84b2f1cbb799eeb457497a1f92027dff74598406aa0d5",
  );
  const build = between(
    fixture,
    "  const compiled = await build({",
    "\n  return compiled.outputFiles",
  );
  assert.equal(digest(build), "0d2e869be3ea6f821719d1cb9cc451643c4aaab9a740eb6177c6db6b81a0471e");
  const assertions = await readFile("tests/helpers/prompt-hook-assertions.ts", "utf8");
  assert.equal(
    digest(between(assertions, "  expect(result).toEqual({", "\n}\n\nexport type")),
    "3486d615c7da820a71e2d7922852ef0e963fef49eed68742e4a9a507fb5b6dea",
  );
  const recording = between(assertions, "  console.log(JSON.stringify(result", "\n}\n");
  assert.equal(
    digest(recording.replace("await attach(", "await testInfo.attach(")),
    "0cbb3c7b322c9866ddc72de24b54f0c5af4e47c31559a46b7aff6a2f64ee08f2",
  );
});

test("only one typed name site changes, retaining dynamic original naming", () => {
  const original = promptHookCostsBody({ kind: "original" });
  const name = 'prompt-costs-run-"\\\n';
  const owned = promptHookCostsBody({ kind: "owned", name });
  assert.equal(original.split('"prompt-costs-" + Date.now()').length, 2);
  assert.equal(owned, original.replace('"prompt-costs-" + Date.now()', JSON.stringify(name)));
  assert.equal(owned.includes('mode:"fast"'), true);
});

function adapter(path = join(tmpdir(), "prompt-hook-unit-result.json")) {
  const previous = process.env.BASH_WEB_MEASURE;
  process.env.BASH_WEB_MEASURE = "1";
  try {
    return createPromptHookAdapter(path);
  } finally {
    if (previous === undefined) delete process.env.BASH_WEB_MEASURE;
    else process.env.BASH_WEB_MEASURE = previous;
  }
}

test("hosted inventory is exactly H01/H02 and requires the flag before resources", async () => {
  const source = await readFile("tests/prompt-hook.spec.ts", "utf8");
  assert.equal(source.match(/\btest\("/g)?.length, 2);
  for (const entry of promptHookCases)
    assert.ok(source.includes(`test(${JSON.stringify(entry.label)},`));
  assert.ok(
    source.includes(
      'test.skip(!process.env.BASH_WEB_MEASURE, "set BASH_WEB_MEASURE=1 to measure")',
    ),
  );
  const previous = process.env.BASH_WEB_MEASURE;
  delete process.env.BASH_WEB_MEASURE;
  try {
    assert.throws(
      () => createPromptHookAdapter(join(tmpdir(), "unused.json")),
      /BASH_WEB_MEASURE=1 before resources/,
    );
  } finally {
    if (previous !== undefined) process.env.BASH_WEB_MEASURE = previous;
  }
  const suite = adapter();
  assert.deepEqual(
    suite.inventory().map(({ id, label }) => ({ id, label })),
    promptHookCases,
  );
  assert.deepEqual(
    suite.inventory().map((entry) => entry.request("run")),
    [{ caseId: "H01" }, { caseId: "H02" }],
  );
  assert.deepEqual(suite.policy.listIds(promptHookCases), ["H01", "H02"]);
  assert.throws(() => suite.policy.listIds(promptHookCases.slice(1)));
  assert.throws(() => suite.policy.listIds(promptHookCases.toReversed()));
  assert.throws(() => suite.policy.listIds(promptHookCases.concat(promptHookCases)));
  assert.deepEqual(suite.budgets(2), {
    hello: 20_000,
    heartbeat: 10_000,
    case: 60_000,
    teardown: 60_000,
    caseDocument: 150_000,
    group: 90_000,
    run: 420_000,
  });
  assert.deepEqual(suite.page, { path: "/prompt-hook-fixture", script: "/prompt-hook-page.js" });
  const allocation = suite.policy.allocation;
  assert.ok(allocation);
  allocation({ kind: "indexeddb", name: "prompt-costs-run" }, ["H02"], "run");
  assert.throws(() =>
    allocation({ kind: "indexeddb", name: "prompt-costs-timestamp" }, ["H02"], "run"),
  );
  assert.throws(() => allocation({ kind: "indexeddb", name: "prompt-costs-run" }, [], "run"));
});

function host(overrides: Partial<HostCase> = {}): HostCase {
  return {
    signal: new AbortController().signal,
    remainingMs: () => 60_000,
    holdAsset: () => assert.fail("unexpected asset hold"),
    setTimeout: () => assert.fail("unexpected timeout change"),
    openPeer: async () => assert.fail("unexpected peer page"),
    allocateDatabase: async () => assert.fail("unexpected allocation"),
    task: async () => assert.fail("unexpected task"),
    script: async () => assert.fail("unexpected script"),
    sleep: (ms) => delay(ms),
    ...overrides,
  };
}

const costs = {
  lookupMemory: { median: 1, p95: 2, samples: 200 },
  lookupFast: { median: 3, p95: 4, samples: 200 },
  enterToPromptWithout: { median: 5, p95: 6, samples: 50 },
  enterToPromptWith: { median: 7, p95: 8, samples: 50 },
  addedByHook: 2,
  pushToRedraw: { median: 9, p95: 10, samples: 50 },
};

test("H02 waits for actual allocation before in-case compile and real task result before sink", async (t) => {
  t.mock.method(console, "log", () => {});
  const allocation = Promise.withResolvers<string>();
  const compiling = Promise.withResolvers<string>();
  const task = Promise.withResolvers<void>();
  const sink = Promise.withResolvers<void>();
  const events = ["case-start"];
  const driving = drivePromptHook(
    host({
      allocateDatabase: async (prefix) => {
        assert.equal(prefix, "prompt-costs");
        events.push("allocate");
        return allocation.promise;
      },
      task: async (source) => {
        assert.equal(source, promptHookModuleTask("compiled"));
        events.push("task");
        await task.promise;
      },
      script: async (source) => {
        assert.equal(source, "return window.__promptHookResult;");
        events.push("script");
        return costs;
      },
    }),
    "H02",
    async (name, options) => {
      assert.equal(name, "prompt-hook-costs");
      assert.deepEqual(options, {
        body: JSON.stringify(costs, null, 2),
        contentType: "application/json",
      });
      events.push("sink");
      await sink.promise;
    },
    async (body) => {
      assert.equal(body, promptHookCostsBody({ kind: "owned", name: "prompt-costs-real-run" }));
      events.push("compile");
      return compiling.promise;
    },
  );
  assert.deepEqual(events, ["case-start", "allocate"]);
  allocation.resolve("prompt-costs-real-run");
  await delay(0);
  assert.deepEqual(events, ["case-start", "allocate", "compile"]);
  compiling.resolve("compiled");
  await delay(0);
  assert.equal(events.at(-1), "task");
  task.resolve();
  await delay(0);
  assert.equal(events.at(-1), "sink");
  sink.resolve();
  assert.equal(await driving, costs);
  assert.deepEqual(events, ["case-start", "allocate", "compile", "task", "script", "sink"]);
});

test("failed allocation, late compile and proof/sink rejection cannot fabricate a result", async (t) => {
  t.mock.method(console, "log", () => {});
  const primary = new Error("allocation denied");
  await assert.rejects(
    drivePromptHook(
      host({
        allocateDatabase: async () => {
          throw primary;
        },
      }),
      "H02",
      async () => assert.fail(),
      async () => assert.fail(),
    ),
    (error) => error === primary,
  );
  const controller = new AbortController();
  const compiling = Promise.withResolvers<string>();
  const aborted = drivePromptHook(
    host({ signal: controller.signal }),
    "H01",
    async () => assert.fail(),
    async (body) => {
      assert.equal(body, promptHookBody);
      return compiling.promise;
    },
  );
  controller.abort(primary);
  compiling.resolve("too late");
  await assert.rejects(aborted, (error) => error === primary);
  const failedTask = host({
    task: async () => {
      throw primary;
    },
  });
  await assert.rejects(
    drivePromptHook(
      failedTask,
      "H01",
      async () => assert.fail(),
      async () => "fixture",
    ),
    (error) => error === primary,
  );
  await assert.rejects(
    drivePromptHook(
      host({ task: async () => {}, script: async () => ({}) }),
      "H01",
      async () => assert.fail(),
      async () => "fixture",
    ),
  );
  await assert.rejects(
    recordPromptHookCosts(costs, async () => {
      throw primary;
    }),
    (error) => error === primary,
  );
  assert.throws(() => checkPromptHookResult({ renders: 1, prompts: 1 }));
});

function moduleControl() {
  const module: { type: string; src: string; onload?: () => void; onerror?: () => void } = {
    type: "",
    src: "",
  };
  const window: Record<string, unknown> = {};
  const revoked: string[] = [];
  const document = {
    createElement: (tag: string) => {
      assert.equal(tag, "script");
      return module;
    },
    head: { appendChild: (value: unknown) => assert.equal(value, module) },
  };
  const URL = {
    createObjectURL: () => "blob:proof",
    revokeObjectURL: (url: string) => revoked.push(url),
  };
  const operation: Promise<unknown> = runInNewContext(
    `(async () => {${promptHookModuleTask("fixture")}})()`,
    { window, document, URL, Blob },
  );
  return { module, window, revoked, operation };
}

test("Blob module task awaits actual proof settlement and revokes on every outcome", async () => {
  const control = moduleControl();
  const proof = Promise.withResolvers<unknown>();
  control.window.proof = proof.promise;
  assert.equal(control.module.type, "module");
  assert.equal(control.module.src, "blob:proof");
  control.module.onload?.();
  await delay(0);
  assert.equal(control.window.__promptHookResult, undefined);
  assert.deepEqual(control.revoked, []);
  proof.resolve(costs);
  await control.operation;
  assert.equal(control.window.__promptHookResult, costs);
  assert.deepEqual(control.revoked, ["blob:proof"]);
  const failed = moduleControl();
  failed.module.onerror?.();
  await assert.rejects(failed.operation, /module failed to load/);
  assert.deepEqual(failed.revoked, ["blob:proof"]);
  const rejected = moduleControl();
  const primary = new Error("original finally failed");
  const rejection = Promise.withResolvers<unknown>();
  rejected.window.proof = rejection.promise;
  rejected.module.onload?.();
  await delay(0);
  rejection.reject(primary);
  await assert.rejects(rejected.operation, (error) => error === primary);
  assert.deepEqual(rejected.revoked, ["blob:proof"]);
  assert.equal(rejected.window.__promptHookResult, undefined);
});

test("measurement console and actual host container preserve exact original attachment bytes", async (t) => {
  const messages: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => messages.push(args));
  const scratch = await mkdtemp(join(tmpdir(), "hook-sink-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "result.json");
  const entry = adapter(path).inventory()[1];
  assert.ok(entry.drive);
  await entry.drive(
    host({
      allocateDatabase: async () => "prompt-costs-run",
      task: async () => {},
      script: async () => costs,
    }),
  );
  assert.deepEqual(messages, [[JSON.stringify(costs, null, 2)]]);
  assert.deepEqual(JSON.parse(await readFile(`${path}.attachments.json`, "utf8")), {
    attachments: [
      {
        caseId: "H02",
        name: "prompt-hook-costs",
        body: JSON.stringify(costs, null, 2),
        contentType: "application/json",
      },
    ],
  });
});

test("asset bootstrap reuses diagnostics and exact-ledger cleanup without compiling proof", async () => {
  const assets = await adapter().assets({
    scratch: tmpdir(),
    signal: new AbortController().signal,
  });
  assert.deepEqual(Object.keys(assets).sort(), [
    "/fs-worker.js",
    "/programs/shell-engine.wasm",
    "/prompt-hook-page.js",
    "/shell-worker.js",
  ]);
  for (const name of ["shell-worker", "fs-worker"]) {
    const actual = assets[`/${name}.js`];
    assert.equal(typeof actual, "string");
    assert.equal(actual, await readFile(`dist/${name}.js`, "utf8"), name);
  }
  const wasm = assets["/programs/shell-engine.wasm"];
  assert.ok(wasm instanceof Blob);
  const guestBytes = await readFile("public/programs/shell-engine.wasm");
  assert.equal(wasm.size, guestBytes.byteLength);
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), new Uint8Array(guestBytes));
  assert.equal(wasm.type, "application/wasm");
  assert.doesNotMatch(
    String(assets["/prompt-hook-page.js"]),
    /jobsWhileRunning|enterToPromptWithout/,
  );
  const page = await readFile("tests/ios/prompt-hook-page.ts", "utf8");
  assert.match(
    page,
    /import \{ promptStatusDiagnostics \} from "\.\/prompt-status-diagnostics.ts"/,
  );
  assert.match(page, /finish: \(ledger\) => cleanupStorage\(ledger\)/);
});

test("public CLI without a native target exits before native allocation", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "hook-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "result.json");
  const command = spawnSync(
    "bun",
    [
      fileURLToPath(new URL("../../scripts/test-prompt-hook-ios.ts", import.meta.url)),
      "--result",
      path,
    ],
    {
      env: { ...process.env, BASH_WEB_MEASURE: "1", IOS_UDID: "" },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  const precondition = JSON.parse(await readFile(path, "utf8"));
  assert.equal(command.status, precondition.exit, command.stderr);
  assert.deepEqual(precondition, {
    suite: "bash-prompt-hook",
    exit: 3,
    precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
  });
});
