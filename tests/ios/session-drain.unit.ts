import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import type { HostVerdict } from "waffle/testing/page-runner";
import {
  checkSessionDrainResult,
  installSessionDrainFixture,
  sessionDrainAdapter,
  sessionDrainAssets,
  sessionDrainBudgets,
  sessionDrainCases,
  sessionDrainList,
  sessionDrainPreparationMs,
} from "./session-drain";
import { ControlledDrainHost, type DrainOperation } from "./session-drain-controls";
import {
  originalSessionDrainCases,
  portSessionDrainAssertions,
  tokens,
} from "./session-drain-parity";
import {
  record,
  selectSessionDrainDiagnostic,
  sessionDrainIds,
  sessionDrainInventory,
} from "./session-drain-support";

const cases = sessionDrainCases();
const pass: HostVerdict = { status: "pass", result: { assertions: "pass" } };
const fail: HostVerdict = { status: "fail", error: "original body failure" };
let pageBundle = "";
let observedPageBundle = "";

beforeAll(async () => {
  const result = await build({
    entryPoints: [new URL("./session-drain-page.ts", import.meta.url).pathname],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "DrainPageControls",
    write: false,
  });
  pageBundle = result.outputFiles[0].text;
  const observed = await build({
    stdin: {
      contents: 'export * from "./tests/ios/session-drain-page";',
      resolveDir: process.cwd(),
      sourcefile: "drain-observer-control.ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "DrainPageControls",
    write: false,
    plugins: [
      {
        name: "observer-bootstrap-boundary",
        setup(builder) {
          builder.onResolve({ filter: /^waffle\/testing\/page-runner\/page$/ }, () => ({
            path: "page-entry",
            namespace: "observer-control",
          }));
          builder.onLoad({ filter: /.*/, namespace: "observer-control" }, () => ({
            contents: "export const isHostedPage = () => true; export function startPage() {}",
            loader: "js",
          }));
        },
      },
    ],
  });
  observedPageBundle = observed.outputFiles[0].text;
});

function drive(id: string, host = new ControlledDrainHost()) {
  const entry = cases.find((item) => item.id === id);
  assert.ok(entry?.drive, `Missing ${id} callback`);
  return entry.drive(host);
}

function parityOperation(operation: DrainOperation, completedDrainTask: boolean): DrainOperation {
  if (operation.kind === "sleep") return operation;
  if (!completedDrainTask) return { kind: operation.kind, source: tokens(operation.source) };
  assert.equal(operation.kind, "task");
  const wrapped = /^await new Promise\(\(resolve\) => \{([\s\S]*)\}\);$/u.exec(operation.source);
  assert.ok(wrapped?.[1], "D06 uses one awaited completion task");
  const source = wrapped[1];
  assert.equal(source.match(/resolve\(\);/gu)?.length, 1);
  const completion = /Reflect\.set\(window, "setTimeout", timeout\);\s*resolve\(\);/u;
  assert.match(source, completion, "D06 completes only after restoring the original timer");
  return {
    kind: "script",
    source: tokens(source.replace(completion, 'Reflect.set(window, "setTimeout", timeout);')),
  };
}

function pageControl(session: unknown, bashWeb?: unknown, bundle = pageBundle) {
  const logs: unknown[][] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const context = createContext({
    window: {
      sessionDrain: session,
      bashWeb,
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
    },
    console: { error: (...args: unknown[]) => logs.push(args) },
  });
  runInContext(bundle, context);
  async function teardown(verdict: HostVerdict = pass): Promise<unknown> {
    context.verdict = verdict;
    return await runInContext(
      'DrainPageControls.sessionDrainTeardown({id:"D10"}, verdict)',
      context,
    );
  }
  return { context, logs, listeners, teardown };
}

function afterEachError(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof Error || record(error));
  const message: unknown = Reflect.get(error, "message");
  assert.equal(typeof message, "string");
  const value: unknown = JSON.parse(String(message));
  assert.ok(record(value));
  return value;
}

function assertAttachment(value: unknown): void {
  assert.ok(record(value));
  assert.ok(Array.isArray(value.attachments));
  assert.equal(value.attachments.length, 1);
  const attachment: unknown = value.attachments[0];
  assert.ok(record(attachment));
  assert.equal(attachment.name, "browser-startup-diagnostics");
  assert.equal(attachment.contentType, "application/json");
  assert.deepEqual(JSON.parse(String(attachment.body)), { unavailable: true });
}

describe("original session-drain inventory and expressions", () => {
  test("retains all 12 titles and both loop expansions in source order", async () => {
    const original = await originalSessionDrainCases();
    assert.equal(original.length, 12);
    assert.deepEqual(
      cases.map((item) => item.label),
      original.map((item) => item.label),
    );
    assert.deepEqual(
      cases.map((item) => item.id),
      Array.from({ length: 12 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`),
    );
    assert.deepEqual(sessionDrainList({ ids: sessionDrainIds }), sessionDrainIds);
    for (const item of cases) assert.deepEqual(item.request("unimportant-run"), { id: item.id });
  });

  test("rejects missing, reordered, duplicated and omitted collected cases", () => {
    assert.throws(() => sessionDrainList({ ids: sessionDrainIds.slice(1) }));
    assert.throws(() => sessionDrainList({ ids: sessionDrainIds.toReversed() }));
    assert.throws(() => sessionDrainList({ ids: sessionDrainIds.concat(["D01"]) }));
    assert.throws(() => sessionDrainList({ ids: sessionDrainIds.filter((id) => id !== "D08") }));
  });

  test("every original evaluate expression and host sleep is retained in order", async () => {
    const original = await originalSessionDrainCases();
    for (const [index, item] of cases.entries()) {
      const host = new ControlledDrainHost();
      const result = await drive(item.id, host);
      assert.ok(record(result));
      assert.equal(result.id, item.id);
      assert.equal(result.assertions, "pass");
      assert.equal(host.moduleLoads, 1);
      assert.equal(host.operations[0]?.kind, "task");
      assert.match(
        String(Reflect.get(Object(host.operations[0]), "source")),
        /script\.onload.*resolve\(\)/s,
      );
      const body = host.operations
        .slice(2)
        .map((operation, index) => parityOperation(operation, item.id === "D06" && index === 0));
      assert.deepEqual(body, original[index]?.operations, `${item.id} expression parity`);
      assert.ok(JSON.stringify(result).length < 1024, `${item.id} keeps arrays out of reports`);
    }
  });

  test("every original matcher and expected value is retained in order", async () => {
    const original = await originalSessionDrainCases();
    assert.deepEqual(
      await portSessionDrainAssertions(),
      original.map((item) => item.assertions),
    );
  });

  test("preserves the original separate deadlines and preparation helper", async () => {
    assert.deepEqual(sessionDrainBudgets, {
      hello: 20000,
      heartbeat: 10000,
      case: 60000,
      teardown: 60000,
      caseDocument: 150000,
      group: 90000,
      run: 2160000,
    });
    assert.equal(sessionDrainPreparationMs, 60000);
    assert.deepEqual(sessionDrainAdapter.page, {
      path: "/drain-fixture",
      script: "/session-drain-page.js",
    });
    const helper = await readFile(
      new URL("../helpers/session-drain-fixture.ts", import.meta.url),
      "utf8",
    );
    assert.equal(helper.match(/await build\(/gu)?.length, 2);
    assert.match(helper, /shell-admission-fixture/);
  });
});

describe("host assertion regressions on controlled actual values", () => {
  for (const id of ["D03", "D04", "D08", "D09"]) {
    test(`${id} rejects a wrong interior integer, not just length or endpoints`, async () => {
      const host = new ControlledDrainHost();
      host.corruptInterior = true;
      await assert.rejects(drive(id, host));
    });
  }
  test("D05 retains the strict turn bound", async () => {
    const host = new ControlledDrainHost();
    host.burstTurns = 20;
    await assert.rejects(drive("D05", host));
  });
  test("D05 retains the per-delivery limit", async () => {
    const host = new ControlledDrainHost();
    host.maximumDelivery = 32769;
    await assert.rejects(drive("D05", host));
  });
  test("D06 completes instrumentation before another driver script timer", async () => {
    const host = new ControlledDrainHost();
    host.driverScriptTimer = true;
    host.deferredWrite = true;
    await drive("D06", host);
  });
  test("D06 rejects an observer-visible retry timer rather than filtering it", async () => {
    const host = new ControlledDrainHost();
    host.extraObserverDelay = true;
    await assert.rejects(drive("D06", host));
  });
  test("D06 rejects an extra Atomics observer entry", async () => {
    const host = new ControlledDrainHost();
    host.extraObserverWait = true;
    await assert.rejects(drive("D06", host));
  });
  test("D08 rejects phase mismatch after complete output", async () => {
    const host = new ControlledDrainHost();
    host.wrongPhase = true;
    await assert.rejects(drive("D08", host));
  });
  test("D09 retains terminalBytes equality", async () => {
    const host = new ControlledDrainHost();
    host.wrongTerminalBytes = true;
    await assert.rejects(drive("D09", host));
  });
  test("D11 calls the original race helper", async () => {
    const host = new ControlledDrainHost();
    await drive("D11", host);
    assert.equal(host.raceCalls, 1);
    assert.deepEqual(host.state.output, [77]);
  });
  test("D12 compares complete final input including extra bytes", async () => {
    const host = new ControlledDrainHost();
    const script = host.script.bind(host);
    host.script = async (source) => {
      const value = await script(source);
      if (source === "return window.sessionDrain.consumed;") return [42, 43, 99];
      return value;
    };
    await assert.rejects(drive("D12", host));
  }, 10_000);
  test("unknown arithmetic values are validated instead of coerced", async () => {
    const host = new ControlledDrainHost();
    const script = host.script.bind(host);
    host.script = (source) =>
      source === "return window.sessionDrain.turns;" ? Promise.resolve("0") : script(source);
    await assert.rejects(drive("D01", host), /finite number/);
  });
});

describe("adapter setup and hook obligations", () => {
  test("module rejection skips the body and still permits the partial-setup hook", async () => {
    const host = new ControlledDrainHost();
    host.setupFailure = true;
    await assert.rejects(drive("D01", host), /module failed to load/);
    assert.equal(host.operations.length, 1);
    const page = pageControl(undefined);
    assertAttachment(await page.teardown(fail));
    assert.deepEqual(
      page.logs.map((entry) => entry[0]),
      ["Pending browser startup awaits", "Browser startup diagnostics"],
    );
  });
  test("initialization uses remaining setup/body time, never a new deadline", async () => {
    const host = new ControlledDrainHost();
    host.setupRemaining = 0;
    await assert.rejects(installSessionDrainFixture(host), /deadline expired/);
    assert.equal(host.operations.length, 1);
  });
  test("D10 body disposal never suppresses the subsequent afterEach disposal", async () => {
    const host = new ControlledDrainHost();
    await drive("D10", host);
    assert.equal(host.disposed, 1);
    const page = pageControl({
      dispose: async () => {
        host.disposed++;
      },
    });
    await page.teardown();
    assert.equal(host.disposed, 2);
    assert.deepEqual(
      host.operations.filter((operation) => operation.kind === "sleep"),
      [{ kind: "sleep", ms: 100 }],
    );
  });
  test("pageerror evidence keeps its original message and failing diagnostics", async () => {
    const page = pageControl({ dispose: async () => {} });
    runInContext(
      'DrainPageControls.sessionDrainPageError({message:"controlled pageerror"})',
      page.context,
    );
    const result = await page.teardown(fail);
    assert.ok(record(result));
    assert.deepEqual(structuredClone(result.pageErrors), ["controlled pageerror"]);
    assert.deepEqual(page.logs[0], ["controlled pageerror"]);
    assertAttachment(result);
  });

  test("unhandled rejection retains original pageerror logging and hook diagnostics", async () => {
    const page = pageControl({ dispose: async () => {} }, undefined, observedPageBundle);
    const rejection = page.listeners.get("unhandledrejection");
    assert.equal(typeof rejection, "function");
    if (!rejection) throw new Error("Missing unhandled rejection observer");
    rejection({ reason: new Error("controlled unhandled rejection") });
    const result = await page.teardown();
    assert.ok(record(result));
    assert.deepEqual(structuredClone(result.pageErrors), ["controlled unhandled rejection"]);
    assert.deepEqual(page.logs[0], ["controlled unhandled rejection"]);
    assertAttachment(result);
  });

  test("diagnostics follow settled disposal and preserve unavailable attachment", async () => {
    let disposed = false;
    const page = pageControl(
      {
        dispose: async () => {
          disposed = true;
        },
      },
      {
        snapshot: () => {
          assert.ok(disposed);
          return undefined;
        },
      },
    );
    assertAttachment(await page.teardown(fail));
  });
  test("rejected disposal still attempts diagnostics and preserves its cause", async () => {
    let disposed = false;
    const page = pageControl(
      {
        dispose: async () => {
          disposed = true;
          throw new Error("disposal rejected");
        },
      },
      {
        snapshot: () => {
          assert.ok(disposed);
          return undefined;
        },
      },
    );
    await assert.rejects(page.teardown(), (error: unknown) => {
      const value = afterEachError(error);
      assert.equal(value.afterEach, "fail");
      assert.match(String(value.disposalError), /disposal rejected/);
      assertAttachment(value);
      return true;
    });
  });
  test("diagnostic failure cannot replace the disposal failure", async () => {
    const page = pageControl(
      {
        dispose: async () => {
          throw new Error("primary disposal");
        },
      },
      { snapshot: () => ({ broken: true }) },
    );
    await assert.rejects(page.teardown(), (error: unknown) => {
      const value = afterEachError(error);
      assert.match(String(value.disposalError), /primary disposal/);
      assert.match(String(value.diagnosticError), /Invalid browser startup snapshot/);
      return true;
    });
  });
  test("pending disposal remains pending, with no premature diagnostics or success", async () => {
    const disposal = Promise.withResolvers<void>();
    const page = pageControl({ dispose: () => disposal.promise });
    let settled = false;
    const pending = page.teardown(fail).finally(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(settled, false);
      assert.deepEqual(page.logs, []);
    } finally {
      disposal.resolve();
      assertAttachment(await pending);
    }
  });
  test("list and finish do not install or dispose a fixture", async () => {
    const page = pageControl({
      dispose: () => {
        throw new Error("must not run");
      },
    });
    const listed: unknown = await runInContext(
      "DrainPageControls.sessionDrainPage.list()",
      page.context,
    );
    assert.deepEqual(structuredClone(listed), { ids: sessionDrainIds });
    const remaining: unknown = await runInContext(
      "DrainPageControls.sessionDrainPage.finish([])",
      page.context,
    );
    assert.deepEqual(structuredClone(remaining), []);
    assert.equal(page.context.document, undefined);
    assert.deepEqual(page.logs, []);
  });
});

function passingResult() {
  return {
    body: { status: "pass", result: { id: "D01", assertions: "pass", observation: null } },
    teardown: {
      status: "pass",
      result: { id: "D01", afterEach: "pass", pageErrors: [], attachments: [] },
    },
  };
}

test("the result policy rejects phase, status and case identity mismatches", () => {
  checkSessionDrainResult("D01", passingResult());
  for (const value of [
    undefined,
    { body: { status: "pass" } },
    { ...passingResult(), body: { status: "fail", error: "body failed" } },
    { ...passingResult(), teardown: { status: "timeout" } },
  ])
    assert.throws(() => checkSessionDrainResult("D01", value));
  assert.throws(() => checkSessionDrainResult("D02", passingResult()));
});

test("preparation cancellation settles without starting fixture compilation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("controlled preparation cancellation"));
  await assert.rejects(
    sessionDrainAssets({ scratch: "/unused", signal: controller.signal }),
    /controlled preparation cancellation/,
  );
});

test("public-entry asset compilation uses the original fixture and bundled page", async () => {
  const assets = await sessionDrainAssets({
    scratch: "/unused-no-files-are-written",
    signal: new AbortController().signal,
  });
  assert.match(assets["/session-drain-fixture.js"], /new Worker/);
  assert.match(assets["/session-drain-fixture.js"], /shell-admission-fixture/);
  assert.match(assets["/session-drain-page.js"], /function startPage/);
  assert.match(assets["/session-drain-page.js"], /kind: "host"/);
  assert.deepEqual(
    sessionDrainInventory.map((item) => item.id),
    sessionDrainIds,
  );
});

test("session drain explicitly selects only its completed teardown envelope", () => {
  const returned = {
    name: "browser-startup-diagnostics",
    contentType: "application/json",
    body: "false",
  };
  assert.equal(
    selectSessionDrainDiagnostic({ afterEach: "pass", attachments: [returned] }),
    returned,
  );
  assert.equal(selectSessionDrainDiagnostic({ afterEach: "pass", attachments: [] }), null);
  for (const value of [
    returned,
    null,
    { afterEach: "fail", attachments: [returned] },
    { afterEach: "pass", attachments: [returned, returned] },
  ])
    assert.throws(() => selectSessionDrainDiagnostic(value));
});
