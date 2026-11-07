import { expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  ownedDatabase,
  type HostCase,
  type PreparationContext,
  type SuiteAdapter,
} from "waffle/testing/page-runner";
import {
  checkPromptHookResult,
  recordPromptHookCosts,
  type PromptHookAttach,
} from "../helpers/prompt-hook-assertions.ts";
import {
  compilePromptHookProof,
  promptHookBody,
  promptHookCostsBody,
} from "../helpers/prompt-hook-fixture.ts";
import { appendHostAttachments } from "./host-diagnostic-delivery.ts";
import {
  promptHookCases,
  type PromptHookCaseId,
  type PromptHookRequest,
} from "./prompt-hook-contract.ts";

export function promptHookModuleTask(compiled: string): string {
  return `
const moduleUrl = URL.createObjectURL(new Blob([${JSON.stringify(compiled)}], { type: "text/javascript" }));
try {
await new Promise((resolve, reject) => {
  const module = document.createElement("script");
  module.type = "module";
  module.src = moduleUrl;
  module.onload = () => resolve();
  module.onerror = () => reject(new Error("Prompt hook module failed to load"));
  document.head.appendChild(module);
});
if (!("proof" in window)) throw new Error("Prompt hook module did not install its proof");
window.__promptHookResult = await window.proof;
} finally {
  URL.revokeObjectURL(moduleUrl);
}
`;
}

export async function drivePromptHook(
  host: HostCase,
  caseId: PromptHookCaseId,
  attach: PromptHookAttach,
  compile = compilePromptHookProof,
): Promise<unknown> {
  const body =
    caseId === "H01"
      ? promptHookBody
      : promptHookCostsBody({ kind: "owned", name: await host.allocateDatabase("prompt-costs") });
  const compiled = await compile(body);
  host.signal.throwIfAborted();
  await host.task(promptHookModuleTask(compiled));
  const result = await host.script("return window.__promptHookResult;");
  if (caseId === "H01") checkPromptHookResult(result);
  else await recordPromptHookCosts(result, attach);
  return result;
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") throw new Error(`Missing ${key}`);
  return Reflect.get(value, key);
}

const artifacts = [
  { url: "/shell-worker.js", file: "dist/shell-worker.js", wasm: false },
  { url: "/fs-worker.js", file: "dist/fs-worker.js", wasm: false },
  { url: "/programs/shell-engine.wasm", file: "public/programs/shell-engine.wasm", wasm: true },
];

async function readArtifact(
  artifact: (typeof artifacts)[number],
): Promise<[string, string | Blob]> {
  const bytes = await readFile(artifact.file);
  return [
    artifact.url,
    artifact.wasm ? new Blob([bytes], { type: "application/wasm" }) : bytes.toString("utf8"),
  ];
}

async function promptHookAssets({ signal }: PreparationContext) {
  const bootstrap = await build({
    entryPoints: [resolve("tests/ios/prompt-hook-page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  signal.throwIfAborted();
  const entries = await Promise.all(artifacts.map(readArtifact));
  signal.throwIfAborted();
  return Object.fromEntries(
    entries.concat([["/prompt-hook-page.js", bootstrap.outputFiles[0].text]]),
  );
}

function promptHookInventory(resultPath: string) {
  return promptHookCases.map((entry) => ({
    ...entry,
    request: () => ({ caseId: entry.id }),
    drive: (host: HostCase) =>
      drivePromptHook(host, entry.id, (name, options) =>
        appendHostAttachments(resultPath, [{ caseId: entry.id, name, ...options }]),
      ),
  }));
}

export function createPromptHookAdapter(resultPath: string): SuiteAdapter<PromptHookRequest> {
  if (process.env.BASH_WEB_MEASURE !== "1")
    throw new Error("Complete prompt-hook suite requires BASH_WEB_MEASURE=1 before resources");
  if (!isAbsolute(resultPath)) throw new Error("Prompt hook requires an absolute result path");
  return {
    suite: "bash-prompt-hook",
    page: { path: "/prompt-hook-fixture", script: "/prompt-hook-page.js" },
    inventory: () => promptHookInventory(resultPath),
    assets: promptHookAssets,
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 60_000,
      teardown: 60_000,
      caseDocument: 150_000,
      group: 90_000,
      run: 420_000,
    }),
    policy: {
      allocation: ownedDatabase("prompt-costs"),
      requireResult: true,
      listIds(value) {
        expect(value).toEqual(promptHookCases);
        return promptHookCases.map((entry) => entry.id);
      },
      check(id, result) {
        const body = field(result, "body");
        expect(field(body, "status")).toBe("pass");
        if (id === "H01") checkPromptHookResult(field(body, "result"));
        expect(field(field(result, "teardown"), "status")).toBe("pass");
      },
    },
  };
}
