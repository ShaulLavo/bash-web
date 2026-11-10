import * as crypto from "node:crypto";
import * as files from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import * as examples from "../helpers/python-cases";
import { pythonCaseInventory } from "./python-contract";
import { createPythonExpectContext } from "./python-expect";

export interface PythonTestInfo {
  readonly outputDir: string;
  outputPath(name: string): string;
  attach(name: string, options: { contentType: string; path: string }): Promise<void>;
}
interface Declaration {
  label: string;
  callback: (...args: unknown[]) => unknown;
}
function declarations(
  code: string,
  expect: ReturnType<typeof createPythonExpectContext>["expect"],
) {
  const cases: Declaration[] = [];
  function test(label: unknown, callback: unknown) {
    if (typeof label !== "string" || typeof callback !== "function")
      throw new Error("Invalid original Python test declaration");
    cases.push({ label, callback: (...args) => Reflect.apply(callback, undefined, args) });
  }
  runInNewContext(code, {
    URL,
    require(name: string) {
      if (name === "@playwright/test") return { test, expect };
      if (name === "node:fs/promises") return files;
      if (name === "node:crypto") return crypto;
      if (name === "./helpers/python-cases.ts") return examples;
      throw new Error(`Unexpected original Python dependency: ${name}`);
    },
  });
  const labels = cases.map((entry) => entry.label);
  if (JSON.stringify(labels) !== JSON.stringify(pythonCaseInventory.map((entry) => entry.label)))
    throw new Error("Python adapter must execute both complete original cases in order");
  return cases;
}

export async function originalPythonCases() {
  const origin = new URL("../python.spec.ts", import.meta.url);
  const source = await files.readFile(origin, "utf8");
  const compiled = await transform(source, {
    loader: "ts",
    format: "cjs",
    target: "esnext",
    define: { "import.meta.url": JSON.stringify(origin.href) },
  });
  declarations(compiled.code, createPythonExpectContext().expect);
  return pythonCaseInventory.map((entry, index) => ({
    ...entry,
    async run(page: object, info: PythonTestInfo, beforePoll?: () => Promise<void>): Promise<void> {
      const context = createPythonExpectContext(beforePoll);
      const original = declarations(compiled.code, context.expect)[index];
      if (!original) throw new Error(`Missing complete original Python case: ${entry.id}`);
      await original.callback({ page }, info);
      context.finish();
    },
  }));
}
