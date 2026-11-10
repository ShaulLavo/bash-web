import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pythonCases } from "../helpers/python-cases";
import { pythonCaseInventory } from "./python-contract";

const originalHashes = [
  ["tests/python.spec.ts", "32a64834123ce86f518080edbfb4bfd0a02da16e59afd7b79dd4c3f9a22cf6a0"],
  [
    "tests/helpers/python-cases.ts",
    "734b1c42b0dfca45fa23f85fe3887fa017201b230fbc19b6c4b2f43e8ded66fb",
  ],
  ["scripts/measure-python.ts", "465b6b256e6d9a389ac1ea12f99ccb1e114f8c1ca2846262f1ef5d3c72bf9b94"],
  [
    "scripts/test-own-shell-python.ts",
    "732f35c6ce76404b47e3084a2c6a2ee7e60027ea990dbc123c0112f761c6e346",
  ],
];

test("the complete original Python file and its fixture, examples and producer stay unchanged", async () => {
  for (const [path, expected] of originalHashes) {
    const source = await readFile(path);
    assert.equal(createHash("sha256").update(source).digest("hex"), expected, path);
  }
});

test("both exact original titles are present without a subset or an exclusion", async () => {
  const source = await readFile("tests/python.spec.ts", "utf8");
  const labels = Array.from(source.matchAll(/^test\("([^"]+)"/gm), (match) => match[1]);
  assert.deepEqual(
    labels,
    pythonCaseInventory.map((entry) => entry.label),
  );
  assert.deepEqual(
    pythonCaseInventory.map((entry) => entry.id),
    ["PY01", "PY02"],
  );
  assert.doesNotMatch(source, /test\.(skip|fixme|only)\(/);
});

test("all twelve original examples retain full large output expectations", () => {
  assert.equal(pythonCases.length, 12);
  assert.equal(pythonCases[10].stdout.length, 400_000);
  assert.equal(pythonCases[11].stderr.length, 110_000);
});

test("the actual original module registers both complete callbacks and request listeners before startup", async () => {
  const { originalPythonCases } = await import("./python-original");
  const cases = await originalPythonCases();
  assert.deepEqual(
    cases.map((entry) => entry.label),
    pythonCaseInventory.map((entry) => entry.label),
  );
  for (const entry of cases) {
    const events: string[] = [];
    const stopped = new Error(`stop before real fixture startup: ${entry.id}`);
    const page = {
      on(event: string, callback: unknown) {
        assert.equal(typeof callback, "function");
        events.push(event);
      },
      async goto(path: string) {
        events.push(path);
        throw stopped;
      },
    };
    await assert.rejects(
      entry.run(page, {
        outputDir: "/unused",
        outputPath: () => assert.fail("startup did not reach measurement"),
        attach: async () => assert.fail("startup did not reach attachment"),
      }),
      (error: unknown) => error === stopped,
    );
    assert.deepEqual(events, ["request", "/python-tests.html"]);
  }
});
