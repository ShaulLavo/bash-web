import { expect } from "@playwright/test";
import { transform } from "esbuild";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { runInNewContext } from "node:vm";
import type { Budgets, HeldAssetRequest, HostCase, SuiteAdapter } from "waffle/testing/page-runner";
import {
  storageBudget,
  waitForShellReady,
  waitForStartup,
  waitForStorageReady,
  type ReadinessObservation,
  type ReadinessPoll,
} from "../helpers/readiness-policy";
import {
  demoTask,
  startupAssets,
  startupDemo,
  type StartupDemo,
} from "./startup-diagnostics-assets";
import type { StartupRequest } from "./startup-diagnostics-page";

interface OriginalCase {
  id: string;
  label: string;
  run(page: StartupPage): Promise<void>;
}
const poll: ReadinessPoll = async (sample, options) => {
  await expect.poll(sample, options).toBe(true);
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readinessSnapshot(value: unknown): value is NonNullable<ReadinessObservation["snapshot"]> {
  if (!record(value)) return false;
  if (value.state !== undefined && typeof value.state !== "string") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return (
    value.storage === undefined ||
    (record(value.storage) && typeof value.storage.status === "string")
  );
}
export function startupObservation(value: unknown): ReadinessObservation {
  if (!record(value)) throw new Error("Invalid startup observation");
  const snapshot = value.snapshot;
  const failure = value.failure;
  if (failure !== undefined && typeof failure !== "string")
    throw new Error("Invalid failure observation");
  if (snapshot !== undefined && !readinessSnapshot(snapshot))
    throw new Error("Invalid startup snapshot");
  return { snapshot, failure };
}

type StartupEvent =
  | { kind: "evaluation-start"; operation: string; source: string }
  | { kind: "evaluation-end"; operation: string; value: unknown }
  | { kind: "readiness-start" | "readiness-end"; phase: "shell" | "storage" | "startup" }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "workspace"; acknowledged: string };

export class StartupPage {
  readonly evidence: StartupEvent[] = [];
  private effectiveTimeout = 60_000;
  private evaluation = 0;
  private navigated = false;
  constructor(
    private readonly host: HostCase,
    private readonly prefix: string,
    private readonly demo: StartupDemo,
  ) {}
  async route(pattern: string, callback: (request: HeldAssetRequest) => Promise<void>) {
    const path =
      pattern === "**/programs/shell-engine.wasm"
        ? "/programs/shell-engine.wasm"
        : pattern === "**/programs/test-guest.wasm"
          ? "/programs/test-guest.wasm"
          : undefined;
    if (!path || this.navigated) throw new Error("Unexpected original startup route");
    this.host.holdAsset(path, callback);
  }
  async goto(path: string): Promise<void> {
    if (path !== "/?test=1&renderer=canvas" || this.navigated)
      throw new Error("Unexpected original startup navigation");
    const binding = await this.host.script(`const query = new URL(location.href).searchParams;
return {workspace:query.get("workspace"),test:query.get("test"),renderer:query.get("renderer")};`);
    if (!record(binding) || binding.test !== "1" || binding.renderer !== "canvas")
      throw new Error("Startup query was not bound before demo evaluation");
    const acknowledged = await this.host.allocateDatabase(this.prefix);
    expect(acknowledged).toBe(binding.workspace);
    this.evidence.push({ kind: "workspace", acknowledged });
    this.navigated = true;
    await this.host.task(demoTask(this.demo));
  }
  async evaluate(callback: () => unknown): Promise<unknown> {
    const key = `startup-evaluation-${this.evaluation++}`;
    this.evidence.push({ kind: "evaluation-start", operation: key, source: callback.toString() });
    await this.host.task(`const value = await (${callback.toString()})();
(window.__startupValues ??= new Map()).set(${JSON.stringify(key)}, value);`);
    const value = await this.host.script(`const key=${JSON.stringify(key)};
const value=window.__startupValues.get(key);window.__startupValues.delete(key);return value;`);
    this.evidence.push({ kind: "evaluation-end", operation: key, value });
    return value;
  }
  private read = async () =>
    startupObservation(
      await this.host.script(`return {
snapshot:window.bashWeb?.snapshot(),
failure:document.querySelector('[role="alert"]')?.textContent?.trim()
};`),
    );
  private storageCredit(): () => void {
    return storageBudget(this.effectiveTimeout, (timeout) => {
      this.host.setTimeout(timeout);
      this.effectiveTimeout = timeout;
      this.evidence.push({ kind: "timeout", timeoutMs: timeout });
    });
  }
  async ready(): Promise<void> {
    this.evidence.push({ kind: "readiness-start", phase: "shell" });
    await waitForShellReady(this.read, poll);
    this.evidence.push({ kind: "readiness-end", phase: "shell" });
  }
  async storageReady(): Promise<void> {
    this.evidence.push({ kind: "readiness-start", phase: "storage" });
    const settled = this.storageCredit();
    try {
      await waitForStorageReady(this.read, poll);
      this.evidence.push({ kind: "readiness-end", phase: "storage" });
    } finally {
      settled();
    }
  }
  async startupReady(): Promise<void> {
    this.evidence.push({ kind: "readiness-start", phase: "startup" });
    await waitForStartup(this.read, poll, this.storageCredit());
    this.evidence.push({ kind: "readiness-end", phase: "startup" });
  }
}

export async function originalStartupCases(): Promise<OriginalCase[]> {
  const cases: OriginalCase[] = [];
  const test = (label: unknown, callback: unknown) => {
    if (typeof label !== "string" || typeof callback !== "function")
      throw new Error("Invalid original startup test declaration");
    cases.push({
      id: `S0${cases.length + 1}`,
      label,
      async run(page) {
        await Reflect.apply(callback, undefined, [{ page }]);
      },
    });
  };
  const helpers = {
    ready: (page: StartupPage) => page.ready(),
    startupReady: (page: StartupPage) => page.startupReady(),
    storageReady: (page: StartupPage) => page.storageReady(),
  };
  const source = await readFile(new URL("../startup-diagnostics.spec.ts", import.meta.url), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "cjs", target: "esnext" });
  runInNewContext(compiled.code, {
    require(name: string) {
      if (name === "./helpers/browser-test") return { test, expect };
      if (name === "./helpers/readiness") return helpers;
      throw new Error(`Unexpected original startup dependency: ${name}`);
    },
  });
  if (cases.length !== 4 || new Set(cases.map((item) => item.label)).size !== 4)
    throw new Error("Startup diagnostics must execute all four original cases");
  return cases;
}

export const startupBudgets: Budgets = {
  hello: 20_000,
  heartbeat: 10_000,
  case: 60_000,
  teardown: 60_000,
  caseDocument: 270_000,
  group: 90_000,
  run: 1_440_000,
};

export async function createStartupAdapter(
  resultPath: string,
): Promise<SuiteAdapter<StartupRequest>> {
  if (!isAbsolute(resultPath)) throw new Error("Startup diagnostics needs an absolute result path");
  const originals = await originalStartupCases();
  const labels = originals.map((item) => item.label);
  const demo = await startupDemo();
  const inventory = originals.map((item) => ({
    id: item.id,
    label: item.label,
    request: () => ({ id: item.id }),
    query: (run: string) => ({
      test: "1",
      renderer: "canvas",
      workspace: `startup-${item.id}-${run}`,
    }),
    async drive(host: HostCase) {
      const page = new StartupPage(host, `startup-${item.id}`, demo);
      await item.run(page);
      return { id: item.id, assertions: "pass", evidence: page.evidence };
    },
  }));
  return {
    suite: "bash-startup-diagnostics",
    inventory: () => inventory,
    page: { path: "/", script: "/startup-diagnostics-page.js" },
    budgets: () => ({ ...startupBudgets }),
    assets: (context) => startupAssets(context, labels),
    policy: {
      requireResult: true,
      listIds(value) {
        expect(value).toEqual(labels);
        return originals.map((item) => item.id);
      },
      allocation(entry, running, run) {
        if (
          running.length !== 1 ||
          entry.kind !== "indexeddb" ||
          entry.name !== `startup-${running[0]}-${run}`
        )
          throw new Error("Startup allocation is not the exact current-case workspace");
      },
      check(id, value) {
        if (!record(value) || !record(value.body) || !record(value.teardown))
          throw new Error("Missing startup body and teardown result");
        expect(value.body.status).toBe("pass");
        expect(value.body.result).toMatchObject({ id, assertions: "pass" });
        expect(value.teardown.status).toBe("pass");
        expect(value.teardown.result).toEqual({ diagnostic: null, disposal: { status: "pass" } });
      },
    },
  };
}
