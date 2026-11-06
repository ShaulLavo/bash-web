import { expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostCase, SuiteAdapter } from "waffle/testing/page-runner";
import { compilePromptStatusFixture } from "../helpers/prompt-status-fixture.ts";
import { promptStatusCase, type PromptStatusRequest } from "./prompt-status-contract.ts";

export function checkPromptStatusReceipts(receipts: unknown): void {
  expect(receipts).toEqual([
    { generation: "1", status: 0 },
    { generation: "2", status: 1 },
    { generation: "3", status: 0 },
    { generation: "4", status: 1 },
    { generation: "5", status: 0 },
  ]);
}

export function promptStatusModuleTask(compiled: string): string {
  return `
const moduleUrl = URL.createObjectURL(new Blob([${JSON.stringify(compiled)}], { type: "text/javascript" }));
try {
await new Promise((resolve, reject) => {
  const module = document.createElement("script");
  module.type = "module";
  module.src = moduleUrl;
  module.onload = () => resolve();
  module.onerror = () => reject(new Error("Prompt status module failed to load"));
  document.head.appendChild(module);
});
while (!("promptStatusProof" in window)) await new Promise(resolve => setTimeout(resolve, 1));
window.__promptStatusReceipts = await window.promptStatusProof;
} finally {
  URL.revokeObjectURL(moduleUrl);
}
`;
}

export async function drivePromptStatus(
  host: HostCase,
  compile = compilePromptStatusFixture,
): Promise<unknown> {
  const compiled = await compile();
  host.signal.throwIfAborted();
  await host.task(promptStatusModuleTask(compiled));
  const receipts = await host.script("return window.__promptStatusReceipts;");
  checkPromptStatusReceipts(receipts);
  return receipts;
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") throw new Error(`Missing ${key}`);
  return Reflect.get(value, key);
}

export const promptStatusAdapter: SuiteAdapter<PromptStatusRequest> = {
  suite: "bash-prompt-status",
  page: { path: "/prompt-status-fixture", script: "/prompt-status-page.js" },
  inventory: () => [
    {
      ...promptStatusCase,
      request: () => ({ caseId: promptStatusCase.id }),
      drive: (host) => drivePromptStatus(host),
    },
  ],
  policy: {
    requireResult: true,
    listIds(value) {
      expect(value).toEqual([promptStatusCase]);
      return [promptStatusCase.id];
    },
    check(_id, result) {
      const body = field(result, "body");
      expect(field(body, "status")).toBe("pass");
      checkPromptStatusReceipts(field(body, "result"));
      expect(field(field(result, "teardown"), "status")).toBe("pass");
    },
  },
  async assets({ signal }) {
    const compiled = await build({
      entryPoints: [resolve("tests/ios/prompt-status-page.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    signal.throwIfAborted();
    const [shellWorker, fsWorker, shellGuest] = await Promise.all([
      readFile("dist/shell-worker.js", "utf8"),
      readFile("dist/fs-worker.js", "utf8"),
      readFile("public/programs/shell-engine.wasm"),
    ]);
    signal.throwIfAborted();
    return {
      "/prompt-status-page.js": compiled.outputFiles[0].text,
      "/shell-worker.js": shellWorker,
      "/fs-worker.js": fsWorker,
      "/programs/shell-engine.wasm": new Blob([shellGuest], { type: "application/wasm" }),
    };
  },
  budgets: () => ({
    hello: 20_000,
    heartbeat: 10_000,
    case: 60_000,
    teardown: 60_000,
    caseDocument: 150_000,
    group: 150_000,
    run: 420_000,
  }),
};
