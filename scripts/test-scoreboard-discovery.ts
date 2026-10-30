import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { discoverScoreboardTests, runScoreboardTests } from "./scoreboard-tests.ts";

function fixture(body: (directory: string) => void): void {
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
    writeFileSync(resolve(directory, "test-own-shell-browser.ts"), "");
    writeFileSync(resolve(directory, "test-shell-scoreboard-new.ts"), "");
    writeFileSync(resolve(directory, "own-shell-helper.mjs"), "");
    const files = discoverScoreboardTests(directory).map((path) => basename(path));
    assert.equal(new Set(files).size, files.length);
    assert.ok(files.includes("test-own-shell-new.mjs"));
    assert.ok(!files.includes("test-own-shell-browser.ts"));
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

test("scoreboard runs every file with exactly two active files", () => {
  fixture((directory) => {
    const files = discoverScoreboardTests(directory);
    const events = resolve(directory, "events.jsonl");
    for (const [index, file] of files.entries())
      writeFileSync(
        file,
        `import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
test('paired file ${index}', async () => {
  const events = ${JSON.stringify(events)};
  appendFileSync(events, JSON.stringify({ kind: 'start', index: ${index} }) + '\\n');
  writeFileSync(${JSON.stringify(resolve(directory, `${index}.ready`))}, '');
  const deadline = Date.now() + 3000;
  while (!existsSync(${JSON.stringify(resolve(directory, `${index ^ 1}.ready`))})) {
    assert.ok(Date.now() < deadline, 'scoreboard files were serialized');
    await delay(10);
  }
  appendFileSync(events, JSON.stringify({ kind: 'end', index: ${index} }) + '\\n');
});
`,
      );
    assert.equal(runScoreboardTests(directory).status, 0);
    let active = 0;
    let peak = 0;
    const completed = [];
    for (const event of readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))) {
      active += event.kind === "start" ? 1 : -1;
      peak = Math.max(peak, active);
      if (event.kind === "end") completed.push(event.index);
    }
    assert.equal(peak, 2);
    assert.equal(active, 0);
    assert.deepEqual(completed.sort(), [0, 1, 2, 3]);
  });
});
