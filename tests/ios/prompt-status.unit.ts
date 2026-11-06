import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { HostCase, HostVerdict } from "waffle/testing/page-runner";
import {
  checkPromptStatusReceipts,
  drivePromptStatus,
  promptStatusAdapter,
  promptStatusModuleTask,
} from "./prompt-status-adapter.ts";
import { promptStatusCase } from "./prompt-status-contract.ts";
import { promptStatusDiagnostics } from "./prompt-status-diagnostics.ts";

const receipts = [
  { generation: "1", status: 0 },
  { generation: "2", status: 1 },
  { generation: "3", status: 0 },
  { generation: "4", status: 1 },
  { generation: "5", status: 0 },
];

test("the complete original input files remain unchanged", async () => {
  const expected = {
    "tests/prompt-status.spec.ts":
      "f181ab0056f163592fc3a5762c64dc7654cbeb98a54d9e480922ab384ae12dbe",
    "tests/helpers/browser-test.ts":
      "55f15bf3fcb61bd96388958cf28f9f8689bd12b909f899decc63f649c7001520",
    "tests/helpers/signal-status-guest.ts":
      "cfe291254825e77a836d1ffa1160ae1d772021702bdec6d09f0443393df273c0",
    "tests/helpers/wasm-binary.ts":
      "9289d1ca08baa71af542f50b00ed4cf78e263f442975207eedbcd7f55dd55c29",
  };
  for (const [path, sha256] of Object.entries(expected)) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      sha256,
      path,
    );
  }
});

function buildBlock(source: string): string {
  const start = source.indexOf("  const compiled = await build({");
  assert.ok(start >= 0);
  const end = source.indexOf("\n  });", start);
  assert.ok(end > start);
  return source.slice(start, end + "\n  });".length);
}

test("the whole proof, send/until, finally and esbuild options have byte parity", async () => {
  const original = await readFile("tests/prompt-status.spec.ts", "utf8");
  const fixture = await readFile("tests/helpers/prompt-status-fixture.ts", "utf8");
  assert.equal(buildBlock(fixture), buildBlock(original));
  const start = original.indexOf("  expect(receipts).toEqual([");
  const end = original.indexOf("\n  ]);", start);
  assert.ok(start >= 0 && end > start);
  const adapter = await readFile("tests/ios/prompt-status-adapter.ts", "utf8");
  assert.ok(adapter.includes(original.slice(start, end + "\n  ]);".length)));
});

test("one inventory entry preserves the original exact title and complete host receipts", async () => {
  const original = await readFile("tests/prompt-status.spec.ts", "utf8");
  assert.equal(original.match(/\btest\("/g)?.length, 1);
  assert.ok(original.startsWith('import { build } from "esbuild";'));
  assert.ok(original.includes(`test(${JSON.stringify(promptStatusCase.label)}, async (`));
  const inventory = promptStatusAdapter.inventory();
  assert.equal(inventory.length, 1);
  assert.deepEqual({ id: inventory[0].id, label: inventory[0].label }, promptStatusCase);
  assert.deepEqual(inventory[0].request("run"), { caseId: "P01" });
  assert.deepEqual(promptStatusAdapter.policy.listIds([promptStatusCase]), ["P01"]);
  assert.throws(() => promptStatusAdapter.policy.listIds([]));
  assert.throws(() => promptStatusAdapter.policy.listIds([{ id: "P01", label: "renamed" }]));
  checkPromptStatusReceipts(receipts);
  assert.throws(() => checkPromptStatusReceipts(receipts.slice(0, 4)));
  assert.throws(() => checkPromptStatusReceipts(receipts.concat(receipts)));
  for (let index = 0; index < receipts.length; index++) {
    const wrong = receipts.map((receipt, at) =>
      at === index ? { ...receipt, status: 99 } : receipt,
    );
    assert.throws(() => checkPromptStatusReceipts(wrong));
  }
});

test("collector checks the full actual body result and teardown", () => {
  const result = {
    body: { status: "pass", result: receipts },
    teardown: { status: "pass", result: null },
  };
  promptStatusAdapter.policy.check("P01", result);
  assert.throws(() =>
    promptStatusAdapter.policy.check("P01", {
      ...result,
      body: { status: "pass", result: [{ generation: "1", status: 0 }] },
    }),
  );
  assert.throws(() =>
    promptStatusAdapter.policy.check("P01", { ...result, teardown: { status: "fail" } }),
  );
});

test("the original setup/body clock and separate diagnostic teardown clock remain bounded", async () => {
  const original = await readFile("playwright.config.ts", "utf8");
  assert.match(original, /timeout: 60000,/);
  assert.deepEqual(promptStatusAdapter.budgets(1), {
    hello: 20_000,
    heartbeat: 10_000,
    case: 60_000,
    teardown: 60_000,
    caseDocument: 150_000,
    group: 150_000,
    run: 420_000,
  });
});

test("assets serve only the page bootstrap and normal-produced workers and typed WASM", async () => {
  const assets = await promptStatusAdapter.assets({
    scratch: process.env.TMPDIR ?? "/work/tmp",
    signal: new AbortController().signal,
  });
  assert.deepEqual(Object.keys(assets).sort(), [
    "/fs-worker.js",
    "/programs/shell-engine.wasm",
    "/prompt-status-page.js",
    "/shell-worker.js",
  ]);
  assert.equal(assets["/shell-worker.js"], await readFile("dist/shell-worker.js", "utf8"));
  assert.equal(assets["/fs-worker.js"], await readFile("dist/fs-worker.js", "utf8"));
  const wasm = assets["/programs/shell-engine.wasm"];
  assert.ok(wasm instanceof Blob);
  assert.equal(wasm.type, "application/wasm");
  assert.deepEqual(
    Buffer.from(await wasm.arrayBuffer()),
    await readFile("public/programs/shell-engine.wasm"),
  );
  assert.equal(typeof assets["/prompt-status-page.js"], "string");
  assert.doesNotMatch(
    String(assets["/prompt-status-page.js"]),
    /late subscriber lost the prompt receipt/,
  );
});

function hostControl(task: HostCase["task"], script: HostCase["script"]): HostCase {
  return {
    signal: new AbortController().signal,
    remainingMs: () => 60_000,
    task,
    script,
    sleep: (ms) => delay(ms),
  };
}

test("drive compiles inside case execution and awaits the task before reading actual receipts", async () => {
  const compiling = Promise.withResolvers<string>();
  const task = Promise.withResolvers<void>();
  const events: string[] = ["case-start"];
  const host = hostControl(
    async (source) => {
      assert.equal(source, promptStatusModuleTask("fixture"));
      events.push("task-start");
      await task.promise;
      events.push("task-settled");
    },
    async (source) => {
      assert.equal(source, "return window.__promptStatusReceipts;");
      events.push("script");
      return receipts;
    },
  );
  const driving = drivePromptStatus(host, () => {
    events.push("compile");
    return compiling.promise;
  });
  assert.deepEqual(events, ["case-start", "compile"]);
  compiling.resolve("fixture");
  await delay(0);
  assert.deepEqual(events, ["case-start", "compile", "task-start"]);
  task.resolve();
  assert.equal(await driving, receipts);
  assert.deepEqual(events, ["case-start", "compile", "task-start", "task-settled", "script"]);
});

test("drive rejects wrong actual receipts and retains the original task failure", async () => {
  const wrong = hostControl(
    async () => {},
    async () => receipts.slice(1),
  );
  await assert.rejects(drivePromptStatus(wrong, async () => "fixture"));
  const primary = new Error("original proof failed after finally");
  const failed = hostControl(
    async () => {
      throw primary;
    },
    async () => assert.fail("must not read receipts from a failed task"),
  );
  await assert.rejects(
    drivePromptStatus(failed, async () => "fixture"),
    (error) => error === primary,
  );
});

function moduleControl() {
  const module: {
    type: string;
    src: string;
    onload?: () => void;
    onerror?: () => void;
  } = { type: "", src: "" };
  const window: Record<string, unknown> = {};
  let appended = false;
  const revoked: string[] = [];
  const URL = {
    createObjectURL(blob: Blob) {
      assert.equal(blob.type.split(";")[0], "text/javascript");
      return "blob:original-module";
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };
  const document = {
    createElement: (tag: string) => {
      assert.equal(tag, "script");
      return module;
    },
    head: {
      appendChild: (element: unknown) => {
        assert.equal(element, module);
        appended = true;
      },
    },
  };
  const operation: Promise<unknown> = runInNewContext(
    `(async () => {${promptStatusModuleTask("original module")}})()`,
    { window, document, setTimeout, URL, Blob },
  );
  return { window, module, operation, appended, revoked };
}

test("page task awaits real module load, proof presence and complete asynchronous settlement", async () => {
  const control = moduleControl();
  assert.equal(control.appended, true);
  assert.equal(control.module.type, "module");
  assert.equal(control.module.src, "blob:original-module");
  assert.deepEqual(control.revoked, []);
  assert.equal(control.window.__promptStatusReceipts, undefined);
  control.module.onload?.();
  await delay(5);
  const proof = Promise.withResolvers<unknown>();
  control.window.promptStatusProof = proof.promise;
  await delay(5);
  assert.equal(control.window.__promptStatusReceipts, undefined);
  proof.resolve(receipts);
  await control.operation;
  assert.equal(control.window.__promptStatusReceipts, receipts);
  assert.deepEqual(control.revoked, ["blob:original-module"]);
});

test("module error or rejected proof fails the task without fabricated receipts", async () => {
  const loading = moduleControl();
  loading.module.onerror?.();
  await assert.rejects(loading.operation, /Prompt status module failed to load/);
  assert.deepEqual(loading.revoked, ["blob:original-module"]);
  assert.equal(loading.window.__promptStatusReceipts, undefined);
  const running = moduleControl();
  const proof = Promise.withResolvers<unknown>();
  let finalized = false;
  running.window.promptStatusProof = proof.promise.finally(() => {
    finalized = true;
  });
  running.module.onload?.();
  await delay(5);
  const primary = new Error("reader failed");
  proof.reject(primary);
  await assert.rejects(running.operation, (error) => error === primary);
  assert.equal(finalized, true);
  assert.deepEqual(running.revoked, ["blob:original-module"]);
  assert.equal(running.window.__promptStatusReceipts, undefined);
});

test("automatic failure diagnostics preserve messages, attachment and unavailable snapshot", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const messages: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => messages.push(args));
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  assert.equal(await promptStatusDiagnostics({ status: "pass", result: receipts }), null);
  assert.equal(messages.length, 0);
  const primary: HostVerdict = { status: "fail", error: "original assertion failure" };
  assert.deepEqual(await promptStatusDiagnostics(primary), {
    name: "browser-startup-diagnostics",
    body: JSON.stringify({ unavailable: true }, null, 2),
    contentType: "application/json",
  });
  assert.deepEqual(messages[0], ["Pending browser startup awaits", "snapshot unavailable"]);
  assert.deepEqual(messages[1], [
    "Browser startup diagnostics",
    JSON.stringify({ unavailable: true }, null, 2),
  ]);
  const snapshot = { startup: { pending: ["real startup wait", "worker ready"] }, retained: 42 };
  Object.defineProperty(globalThis, "window", {
    value: { bashWeb: { snapshot: () => snapshot } },
    configurable: true,
  });
  assert.deepEqual(await promptStatusDiagnostics(primary), {
    name: "browser-startup-diagnostics",
    body: JSON.stringify(snapshot, null, 2),
    contentType: "application/json",
  });
  assert.deepEqual(messages[2], [
    "Pending browser startup awaits",
    "real startup wait, worker ready",
  ]);
  Object.defineProperty(globalThis, "window", {
    value: {
      bashWeb: {
        snapshot: () => {
          throw new Error("snapshot unavailable");
        },
      },
    },
    configurable: true,
  });
  assert.deepEqual(await promptStatusDiagnostics(primary), {
    name: "browser-startup-diagnostics",
    body: JSON.stringify({ unavailable: true }, null, 2),
    contentType: "application/json",
  });
  assert.deepEqual(primary, { status: "fail", error: "original assertion failure" });
});

test("empty IOS_UDID stops the actual public CLI before native allocation", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? "/work/tmp", "prompt-status-cli-"));
  try {
    const path = join(scratch, "result.json");
    const command = spawnSync("bun", ["scripts/test-prompt-status-ios.ts", "--result", path], {
      env: { ...process.env, IOS_UDID: "" },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(command.status, 3, command.stderr);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      suite: "bash-prompt-status",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
