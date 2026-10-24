import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { discoverScoreboardTests, runScoreboardTests } from "./scoreboard-tests.mjs";

function fixture(body) {
  const directory = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "scoreboard-discovery-"));
  try {
    for (const file of [
      "test-own-shell-fixture.ts",
      "test-shell-scoreboard-fixture.mjs",
      "test-bash-compat-fixture.mjs",
      "test-compat-selection.mjs",
    ])
      writeFileSync(
        resolve(directory, file),
        "import test from 'node:test'; test('discovered', () => {});\n",
      );
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  }
}
test("new mjs and ts entrypoints are discovered once in deterministic order", () => {
  fixture((directory) => {
    writeFileSync(resolve(directory, "test-own-shell-new.mjs"), "");
    writeFileSync(resolve(directory, "test-shell-scoreboard-new.ts"), "");
    writeFileSync(resolve(directory, "own-shell-helper.mjs"), "");
    const files = discoverScoreboardTests(directory).map((path) => basename(path));
    assert.equal(new Set(files).size, files.length);
    assert.ok(files.includes("test-own-shell-new.mjs"));
    assert.ok(files.includes("test-shell-scoreboard-new.ts"));
    assert.ok(!files.includes("own-shell-helper.mjs"));
    assert.deepEqual(files, files.toSorted());
  });
});
test("missing mandatory families and symlinked entrypoints fail closed", () => {
  fixture((directory) => {
    symlinkSync("test-compat-selection.mjs", resolve(directory, "test-own-shell-link.mjs"));
    assert.throws(() => discoverScoreboardTests(directory), /regular files/);
    rmSync(resolve(directory, "test-own-shell-link.mjs"));
    rmSync(resolve(directory, "test-compat-selection.mjs"));
    assert.throws(() => discoverScoreboardTests(directory), /empty scoreboard family/);
  });
});
test("a failing newly discovered test fails the actual runner", () => {
  fixture((directory) => {
    assert.equal(runScoreboardTests(directory).status, 0);
    writeFileSync(
      resolve(directory, "test-own-shell-failure.ts"),
      "throw new Error('discovered failure');\n",
    );
    assert.notEqual(runScoreboardTests(directory).status, 0);
  });
});
