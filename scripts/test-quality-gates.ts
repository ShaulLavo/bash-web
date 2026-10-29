import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ProgramPackage } from "waffle/programs";
import { duplicateArgs, duplicateModes } from "./check-duplicates.ts";
import { compatibilityPrograms } from "./compat-programs.ts";
import { selectBasePackages } from "./waffle-compat.ts";

interface ToolResult {
  status: number | null;
  output: string;
}

const root = resolve(import.meta.dirname, "..");
function fixture(run: (directory: string) => void) {
  const parent = resolve(root, ".scratch");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "quality-probe-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function tool(name: string, args: readonly string[], cwd = root): ToolResult {
  const result = spawnSync(resolve(root, "node_modules/.bin", name), args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
function passed(result: ToolResult) {
  assert.equal(result.status, 0, result.output);
}
function rejected(result: ToolResult, diagnostic: RegExp) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, diagnostic);
}

test("compatibility admits exactly the historical ten published programs", () => {
  const expected = ["cat", "find", "grep", "head", "mkdir", "seq", "sort", "tail", "uniq", "wc"];
  assert.deepEqual(compatibilityPrograms, expected);
  const programs: ProgramPackage["programs"] = expected
    .concat(["touch", "sed", "which", "ls", "env"])
    .map((name) => ({
      path: `/usr/bin/${name}`,
      source: async () => new Uint8Array(),
    }));
  const selected = selectBasePackages([{ name: "base", programs }], compatibilityPrograms);
  assert.deepEqual(
    selected.flatMap((family) => family.programs.map((program) => program.path)),
    expected.map((name) => `/usr/bin/${name}`),
  );
});

const lintCases: [string, string, RegExp][] = [
  ["debugger", "debugger;\n", /no-debugger/],
  ["ambient browser name", "console.log(name);\n", /no-restricted-globals/],
];
for (const [label, source, diagnostic] of lintCases) {
  test(`lint rejects ${label}`, () =>
    fixture((directory) => {
      const file = resolve(directory, "probe.ts");
      const args = [
        "--config",
        resolve(root, ".oxlintrc.json"),
        "--deny-warnings",
        "--no-ignore",
        file,
      ];
      writeFileSync(file, "console.log('valid');\n");
      passed(tool("oxlint", args));
      writeFileSync(file, source);
      rejected(tool("oxlint", args), diagnostic);
    }));
}

test("strict types reject an incompatible value", () =>
  fixture((directory) => {
    const file = resolve(directory, "probe.ts");
    const config = resolve(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({ extends: resolve(root, "tsconfig.json"), include: [file] }),
    );
    writeFileSync(file, "export const value: number = 1;\n");
    passed(tool("tsc", ["--project", config]));
    writeFileSync(file, 'export const value: number = "wrong";\n');
    rejected(tool("tsc", ["--project", config]), /not assignable to type 'number'/);
  }));

test("Knip rejects an unreferenced authored file", () =>
  fixture((directory) => {
    copyFileSync(resolve(root, ".knip.jsonc"), resolve(directory, ".knip.jsonc"));
    mkdirSync(resolve(directory, "src"));
    writeFileSync(
      resolve(directory, "package.json"),
      JSON.stringify({
        name: "quality-probe",
        private: true,
        type: "module",
        exports: "./src/index.ts",
      }),
    );
    writeFileSync(resolve(directory, "src/index.ts"), "export const used = 1;\n");
    // Config hints about absent real-world roots are not errors in the miniature project.
    const args = ["--config", ".knip.jsonc", "--no-progress", "--no-config-hints"];
    passed(tool("knip", args, directory));
    writeFileSync(resolve(directory, "src/unreachable.ts"), "export const orphan = 2;\n");
    rejected(tool("knip", args, directory), /Unused files[\s\S]*src\/unreachable\.ts/);
  }));

const rustFunction = (
  functionName: string,
  parameter: string,
) => `fn ${functionName}(${parameter}: i32) -> i32 {
  let mut answer = 0;
  for counter in 0..${parameter} {
    if counter % 2 == 0 { answer += counter * 3; }
    else { answer -= counter / 2; }
    answer = answer.wrapping_add(counter);
  }
  if answer > 100 { answer / 2 } else { answer + 7 }
}
`;
for (const mode of duplicateModes) {
  test(`${mode} rejects a new clone against a fixed baseline`, () =>
    fixture((directory) => {
      const baseline = resolve(directory, "baseline.json");
      const sources = resolve(directory, "source");
      mkdirSync(sources);
      writeFileSync(resolve(sources, "alpha.rs"), rustFunction("alpha", "limit"));
      passed(tool("jscpd", duplicateArgs(mode, baseline, [sources], true), directory));
      passed(tool("jscpd", duplicateArgs(mode, baseline, [sources]), directory));
      const clone =
        mode === "exact" ? rustFunction("alpha", "limit") : rustFunction("beta", "maximum");
      writeFileSync(resolve(sources, "beta.rs"), clone);
      rejected(
        tool("jscpd", duplicateArgs(mode, baseline, [sources]), directory),
        /new clone|\[NEW\]/i,
      );
    }));
  test(`${mode} rejects an unexpectedly empty scan`, () =>
    fixture((directory) => {
      const sources = resolve(directory, "empty");
      mkdirSync(sources);
      const baseline = resolve(directory, "baseline.json");
      writeFileSync(baseline, JSON.stringify({ version: 1, fingerprints: {} }));
      rejected(
        tool("jscpd", duplicateArgs(mode, baseline, [sources]), directory),
        /no files|empty/i,
      );
    }));
}
