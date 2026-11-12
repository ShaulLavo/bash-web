import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import type { HostCase, HostPeer } from "waffle/testing/page-runner";
import {
  StartupPage,
  originalStartupCases,
  startupBudgets,
  startupObservation,
} from "./startup-diagnostics";
import { demoTask, startupDemo } from "./startup-diagnostics-assets";
import { startupTeardown } from "./startup-diagnostics-page";

const demo = {
  entry: "/assets/demo.js",
  body: '<div id="app"></div>',
  styles: ["/assets/demo.css"],
};

class StartupControl implements HostCase {
  async workers(): Promise<never> {
    assert.fail("unexpected browser Worker observation");
  }
  onWorker(): never {
    throw new Error("unexpected browser Worker subscription");
  }
  async waitForWorkerClose(): Promise<never> {
    throw new Error("unexpected browser Worker close wait");
  }
  onRequest(): never {
    assert.fail("unexpected browser request observation");
  }
  async press(): Promise<never> {
    assert.fail("unexpected key input");
  }
  readonly signal = new AbortController().signal;
  readonly events: string[] = [];
  readonly timeouts: number[] = [];
  readonly restart = Promise.withResolvers<void>();
  readonly context = createContext({
    window: {
      bashWeb: {
        restart: () => {
          this.events.push("restart-entered");
          return this.restart.promise;
        },
        snapshot: () => ({ state: "ready", error: undefined, storage: { status: "ready" } }),
      },
    },
    document: { querySelector: () => undefined },
  });
  holdAsset(): void {
    assert.fail("unexpected asset hold");
  }
  async openPeer(): Promise<HostPeer> {
    assert.fail("startup must not create a peer");
  }
  remainingMs(): number {
    return 60_000;
  }
  setTimeout(timeout: number): void {
    this.timeouts.push(timeout);
  }
  async allocateDatabase(): Promise<string> {
    this.events.push("allocation-acknowledged");
    return "startup-S01-run";
  }
  async script(source: string): Promise<unknown> {
    this.events.push("script");
    if (source.includes("location.href"))
      return { workspace: "startup-S01-run", test: "1", renderer: "canvas" };
    return runInContext(`(function(){${source}})()`, this.context);
  }
  async task(source: string): Promise<void> {
    this.events.push("task-entered");
    if (source === demoTask(demo)) return;
    await runInContext(`(async function(){${source}})()`, this.context);
    this.events.push("task-settled");
  }
  async sleep(): Promise<void> {
    assert.fail("unit control has no host polling delay");
  }
}

class WebDriverStartupControl extends StartupControl {
  override async script(source: string): Promise<unknown> {
    const value = await super.script(source);
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => (item === undefined ? null : item)),
    );
  }
}

test("readiness observes an absent alert and unset snapshot error through WebDriver JSON cloning", async () => {
  const host = new WebDriverStartupControl();
  await new StartupPage(host, "startup-S02", demo).startupReady();
  assert.deepEqual(host.events, ["script", "script"]);
});

test("all four originals are compiled without changing their bytes or assertion bodies", async () => {
  const source = await readFile(new URL("../startup-diagnostics.spec.ts", import.meta.url));
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "009474d47d1d3ae97a003725ae5a82c547e466262c86eedb1becb71ca5610d72",
  );
  const cases = await originalStartupCases();
  assert.deepEqual(
    cases.map((item) => item.id),
    ["S01", "S02", "S03", "S04"],
  );
  assert.deepEqual(
    cases.map((item) => item.label),
    Array.from(source.toString().matchAll(/\btest\("([^"]+)"/g), (match) => match[1]),
  );
  assert.equal(source.toString().match(/await route\.continue\(\)/g)?.length, 2);
  assert.equal(source.toString().match(/finally \{\s*release\(\);/g)?.length, 2);
});

test("demo import happens after the exact workspace acknowledgement", async () => {
  const host = new StartupControl();
  const page = new StartupPage(host, "startup-S01", demo);
  await page.goto("/?test=1&renderer=canvas");
  assert.deepEqual(host.events, ["script", "allocation-acknowledged", "task-entered"]);
  await assert.rejects(page.goto("/?test=1&renderer=canvas"));
});

test("restart retains the actual promise while readiness observes and changes its live body deadline", async () => {
  const host = new StartupControl();
  const page = new StartupPage(host, "startup-S03", demo);
  let settled = false;
  const restarting = page
    .evaluate(() => {
      const access: unknown = Reflect.get(window, "bashWeb");
      if (access === null || typeof access !== "object") throw new Error("Missing test API");
      const restart: unknown = Reflect.get(access, "restart");
      if (typeof restart !== "function") throw new Error("Missing restart");
      return Reflect.apply(restart, access, []);
    })
    .then(() => {
      settled = true;
    });
  await page.startupReady();
  assert.equal(settled, false);
  assert.ok(host.events.indexOf("script") > host.events.indexOf("restart-entered"));
  host.restart.resolve();
  await restarting;
  assert.equal(settled, true);
  assert.equal(host.timeouts[0], 120_000);
  assert.ok(host.timeouts[1] >= 60_000 && host.timeouts[1] < host.timeouts[0]);
});

test("both successive storage intervals accumulate instead of resetting the original timeout", async () => {
  const host = new StartupControl();
  const page = new StartupPage(host, "startup-S04", demo);
  await page.storageReady();
  await page.startupReady();
  const [extended, credited, secondExtended, secondCredited] = host.timeouts;
  assert.equal(extended, 120_000);
  assert.ok(credited >= 60_000 && credited < extended);
  assert.equal(secondExtended, credited + 60_000);
  assert.ok(secondCredited >= credited && secondCredited < secondExtended);
  const shell = new StartupControl();
  await new StartupPage(shell, "startup-S01", demo).ready();
  assert.deepEqual(shell.timeouts, []);
});

test("normal emitted asset selection retains the original markup and real module closure", async () => {
  const parsed = await startupDemo();
  assert.match(parsed.entry, /^\/assets\/index-.*\.js$/);
  assert.match(parsed.body, /<div id="app"><\/div>/);
  assert.ok(parsed.styles.every((name) => name.endsWith(".css")));
  assert.doesNotMatch(demoTask(parsed), /window\.fetch|fetchFixture|storage=memory|history\./);
});

test("outer envelopes include two storage intervals and keep teardown separate", () => {
  assert.equal(startupBudgets.case, 60_000);
  assert.equal(startupBudgets.teardown, 60_000);
  assert.equal(startupBudgets.caseDocument, 60_000 + 2 * 60_000 + 20_000 + 60_000 + 10_000);
  assert.ok(
    startupBudgets.run >= 4 * startupBudgets.caseDocument + 2 * startupBudgets.group + 60_000,
  );
});

test("success teardown waits for the real demo disposal promise", async () => {
  const previous = Reflect.get(globalThis, "window");
  const disposal = Promise.withResolvers<void>();
  Reflect.set(globalThis, "window", { bashWeb: { dispose: () => disposal.promise } });
  try {
    let settled = false;
    const teardown = startupTeardown({ id: "S01" }, { status: "pass", result: null }).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await Promise.resolve();
    assert.equal(settled, false);
    disposal.resolve();
    assert.deepEqual(await teardown, { diagnostic: null, disposal: { status: "pass" } });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previous);
  }
});

test("failure diagnostics retain the actual snapshot and both console arguments before failed disposal", async () => {
  const previous = Reflect.get(globalThis, "window");
  const originalError = console.error;
  const logs: unknown[][] = [];
  const snapshot = { startup: { pending: ["test-guest-fetch-requested"] } };
  Reflect.set(globalThis, "window", {
    bashWeb: {
      snapshot: () => snapshot,
      dispose: async () => {
        snapshot.startup.pending = [];
        throw new Error("disposal control");
      },
    },
  });
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const result = await startupTeardown({ id: "S04" }, { status: "fail", error: "body control" });
    const body = JSON.stringify({ startup: { pending: ["test-guest-fetch-requested"] } }, null, 2);
    assert.deepEqual(result.diagnostic, {
      name: "browser-startup-diagnostics",
      contentType: "application/json",
      body,
    });
    assert.deepEqual(logs, [
      ["Pending browser startup awaits", "test-guest-fetch-requested"],
      ["Browser startup diagnostics", body],
    ]);
    assert.deepEqual(result.disposal, { status: "fail", error: "Error: disposal control" });
  } finally {
    console.error = originalError;
    if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previous);
  }
});

test("readiness keeps the whole original observation instead of projecting away failure evidence", () => {
  const snapshot = {
    state: "failed",
    storage: { status: "ready" },
    startup: { pending: ["shell-wasm-fetch-requested"] },
    engine: "own-shell",
    cols: 120,
    error: "real startup failure",
  };
  const observed = startupObservation({ snapshot, failure: "real alert" });
  assert.equal(observed.snapshot, snapshot);
  assert.equal(observed.failure, "real alert");
  assert.throws(() => startupObservation({ snapshot: { state: 12 } }));
  assert.throws(() => startupObservation({ snapshot: { error: null } }));
  assert.throws(() => startupObservation({ failure: null }));
});
