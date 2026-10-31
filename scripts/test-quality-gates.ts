import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import type { ProgramPackage } from "waffle/programs";
import {
  assertBaselineShrinks,
  duplicateArgs,
  duplicateBaseRef,
  duplicateComparison,
  duplicateModes,
  parseDuplicateBaseline,
  shrinkDuplicateBaseline,
  validateDuplicatePlans,
} from "./check-duplicates.ts";
import { checkJavaScript, type JavaScriptException } from "./check-javascript.ts";
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

function runGit(directory: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function writeRepoFile(directory: string, path: string, source = "") {
  const file = resolve(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
function initJavaScriptRepo(directory: string) {
  runGit(directory, ["init", "-q"]);
  writeRepoFile(directory, ".gitignore", "dist/\n.build/\n.scratch/\n");
}

test("JavaScript guard rejects staged and new files across repository roots", () =>
  fixture((directory) => {
    initJavaScriptRepo(directory);
    const files = [
      "probe.js",
      "scripts/probe.mjs",
      "tests/probe.cjs",
      "nested/deep/probe.js",
      "scripts/nested/probe.cjs",
      "tests/nested/probe.mjs",
      "nested/with space.mjs",
      "nested/line\nbreak.cjs",
    ];
    for (const path of files) writeRepoFile(directory, path);
    writeRepoFile(directory, "probe.js", "// check-javascript-disable\n");
    writeRepoFile(
      directory,
      "src/input.ts",
      'export const inputs = ["probe.js", "probe.mjs", "probe.cjs"];\n',
    );
    runGit(directory, ["add", "--"].concat(files.slice(0, 4)));
    assert.deepEqual(checkJavaScript(directory), files.sort());
  }));

test("JavaScript guard allows only exact generated and test-input exceptions", () =>
  fixture((directory) => {
    initJavaScriptRepo(directory);
    const allowedPaths = ["dist/serve.mjs", "fixtures/invalid.js"];
    const rejectedPaths = [
      "dist/other.mjs",
      "dist/nested/serve.mjs",
      "fixtures/invalid.mjs",
      "fixtures/nested/invalid.js",
      "tests/invalid.js",
    ];
    for (const path of allowedPaths.concat(rejectedPaths)) writeRepoFile(directory, path);
    writeRepoFile(directory, "fixtures/invalid.js", "const = ;\n");
    runGit(directory, ["add", "-f", "--"].concat(allowedPaths, rejectedPaths));
    const exceptions = new Map<string, JavaScriptException>([
      ["dist/serve.mjs", { kind: "generated", reason: "Checked-in generated bundle" }],
      ["fixtures/invalid.js", { kind: "test-input", reason: "Invalid parser input" }],
    ]);
    assert.deepEqual(checkJavaScript(directory, exceptions), rejectedPaths.sort());
  }));

test("JavaScript guard ignores generated output and rejects symlinks without following", () =>
  fixture((directory) => {
    initJavaScriptRepo(directory);
    for (const path of ["dist/serve.mjs", ".build/node/api.mjs", ".scratch/candidate.cjs"])
      writeRepoFile(directory, path);
    writeRepoFile(directory, "src/input.ts", 'export const worker = "dist/serve.mjs";\n');
    assert.deepEqual(checkJavaScript(directory), []);
    mkdirSync(resolve(directory, "tests"));
    symlinkSync("../dist/serve.mjs", resolve(directory, "tests/link.js"));
    symlinkSync("../dist/serve.mjs", resolve(directory, "tests/link.ts"));
    runGit(directory, ["add", "--", "tests/link.js", "tests/link.ts"]);
    assert.deepEqual(checkJavaScript(directory), ["tests/link.js"]);
  }));

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

test("Knip checks private entry exports without reporting external package exports", () =>
  fixture((directory) => {
    copyFileSync(resolve(root, ".knip.jsonc"), resolve(directory, ".knip.jsonc"));
    const publicRoots = {
      ".": "./src/index.ts",
      "./shell": "./src/shell.ts",
      "./prompt": "./src/prompt/index.ts",
      "./session": "./src/session.ts",
    };
    writeRepoFile(
      directory,
      "package.json",
      JSON.stringify({
        name: "quality-probe",
        private: true,
        type: "module",
        exports: publicRoots,
      }),
    );
    for (const path of Object.values(publicRoots))
      writeRepoFile(
        directory,
        path,
        "export const publicValue = 1;\nexport type PublicType = number;\n",
      );
    const entry = "scripts/test-own-shell-probe.ts";
    writeRepoFile(directory, entry, "console.log('probe');\n");
    const args = ["--config", ".knip.jsonc", "--no-progress", "--no-config-hints"];
    passed(tool("knip", args, directory));
    writeRepoFile(directory, entry, "export const deadEntryExport = 2;\n");
    rejected(tool("knip", args, directory), /Unused exports[\s\S]*deadEntryExport/);
    writeRepoFile(directory, entry, "export type DeadEntryType = number;\n");
    rejected(tool("knip", args, directory), /Unused exported types[\s\S]*DeadEntryType/);
    writeRepoFile(directory, entry, 'import "../src/shell-commands.ts";\n');
    writeRepoFile(directory, "src/shell-commands.ts", "export const deadInternalExport = 3;\n");
    rejected(tool("knip", args, directory), /Unused exports[\s\S]*deadInternalExport/);
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

const cloneId = "0123456789abcdef";
function explainedBaseline() {
  return {
    version: 1,
    fingerprints: { [cloneId]: 1 },
    reasons: {
      [cloneId]: {
        kind: "fixture",
        reason: "Independent parser failure inputs in the miniature probe.",
      },
    },
  };
}

for (const reason of [undefined, "", "   ", "first line\nsecond line"]) {
  test(`duplicate baselines reject a missing or blank reason ${JSON.stringify(reason)}`, () => {
    const baseline = explainedBaseline();
    const reasons = { [cloneId]: { kind: "fixture", reason } };
    assert.throws(() => parseDuplicateBaseline({ ...baseline, reasons }), /one-line reason/);
  });
}

test("every baseline fingerprint needs its own reason, including new entries", () => {
  const baseline = explainedBaseline();
  assert.throws(() => parseDuplicateBaseline({ ...baseline, reasons: {} }), /Missing reason/);
  assert.throws(
    () =>
      parseDuplicateBaseline({
        ...baseline,
        fingerprints: { ...baseline.fingerprints, fedcba9876543210: 1 },
      }),
    /Missing reason.*fedcba9876543210/,
  );
  assert.throws(() => parseDuplicateBaseline({ ...baseline, fingerprints: {} }), /Reason without/);
  assert.throws(
    () =>
      parseDuplicateBaseline({
        ...baseline,
        reasons: { [cloneId]: { kind: "intentional", reason: "Ordinary production code." } },
      }),
    /Reason kind/,
  );
});

test("record only removes fingerprints and lowers multiplicities without inventing reasons", () => {
  const baseline = parseDuplicateBaseline(explainedBaseline());
  assert.deepEqual(shrinkDuplicateBaseline(baseline, {}), {
    version: 1,
    fingerprints: {},
    reasons: {},
  });
  assert.deepEqual(shrinkDuplicateBaseline(baseline, { [cloneId]: 1 }), baseline);
  assert.throws(() => shrinkDuplicateBaseline(baseline, { [cloneId]: 2 }), /cannot grow/);
  assert.throws(() => shrinkDuplicateBaseline(baseline, { fedcba9876543210: 1 }), /cannot grow/);
  assert.throws(() => assertBaselineShrinks({ [cloneId]: 1 }, {}), /cannot grow/);
});

test("duplicate baseline selection uses the immutable tested parent in shallow CI", () => {
  assert.equal(duplicateBaseRef({}), "origin/main");
  assert.equal(duplicateBaseRef({ GITHUB_ACTIONS: "true" }), "HEAD^");
  assert.equal(
    duplicateBaseRef({ GITHUB_ACTIONS: "true", DUPLICATES_BASE_REF: "a-tested-base" }),
    "a-tested-base",
  );
});

test("unreadable chosen duplicate baselines fail closed instead of using another ref", () =>
  fixture((directory) => {
    runGit(directory, ["init", "-q"]);
    writeRepoFile(directory, "baseline.json", JSON.stringify(explainedBaseline()));
    runGit(directory, ["add", "baseline.json"]);
    runGit(directory, [
      "-c",
      "user.name=Quality probe",
      "-c",
      "user.email=quality@example.invalid",
      "commit",
      "-qm",
      "Record baseline",
    ]);
    assert.deepEqual(duplicateComparison(directory, "baseline.json", "HEAD"), { [cloneId]: 1 });
    writeRepoFile(directory, "baseline.json", JSON.stringify({ fingerprints: {} }));
    assert.deepEqual(duplicateComparison(directory, "baseline.json", "HEAD"), { [cloneId]: 1 });
    runGit(directory, ["add", "baseline.json"]);
    runGit(directory, [
      "-c",
      "user.name=Quality probe",
      "-c",
      "user.email=quality@example.invalid",
      "commit",
      "-qm",
      "Remove clone",
    ]);
    assert.deepEqual(
      duplicateComparison(directory, "baseline.json", duplicateBaseRef({ GITHUB_ACTIONS: "true" })),
      { [cloneId]: 1 },
    );
    assert.deepEqual(duplicateComparison(directory, "baseline.json", "HEAD"), {});
    assert.throws(() => duplicateComparison(directory, "baseline.json", "missing-chosen-ref"));
    assert.throws(() => duplicateComparison(directory, "missing-baseline.json", "HEAD"));
  }));

test("deferred duplicates require an existing Approved removal item", () =>
  fixture((directory) => {
    const baseline = parseDuplicateBaseline({
      ...explainedBaseline(),
      reasons: {
        [cloneId]: {
          kind: "deferred",
          reason: "Share the parser setup after its owning migration lands.",
          plan: "plans/cleanup.md#parser",
        },
      },
    });
    assert.throws(() => validateDuplicatePlans(baseline, directory), /ENOENT/);
    writeRepoFile(directory, "plans/cleanup.md", 'Status: Idea\n<a id="parser"></a>\n');
    assert.throws(() => validateDuplicatePlans(baseline, directory), /must be Approved/);
    writeRepoFile(directory, "plans/cleanup.md", "Status: Approved\n");
    assert.throws(() => validateDuplicatePlans(baseline, directory), /Missing removal item/);
    writeRepoFile(directory, "plans/cleanup.md", 'Status: Approved\n<a id="parser"></a>\n');
    validateDuplicatePlans(baseline, directory);
  }));
