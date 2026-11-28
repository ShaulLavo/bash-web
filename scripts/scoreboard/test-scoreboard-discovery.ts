import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { discoverScoreboardTests, runScoreboardTests } from "./scoreboard-tests.ts";

const families = [
  "test-own-shell-fixture.ts",
  "scoreboard/test-shell-scoreboard-fixture.mjs",
  "compat/test-bash-compat-fixture.mjs",
  "compat/test-compat-selection.mjs",
];

function fixture(body: (directory: string) => void): void {
  const directory = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "scoreboard-discovery-"));
  try {
    for (const file of families) {
      const entry = resolve(directory, file);
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, "import test from 'node:test'; test('discovered', () => {});\n");
    }
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  }
}
test("new mjs and ts entrypoints are discovered once in deterministic order", () => {
  fixture((directory) => {
    mkdirSync(resolve(directory, "replay/runtime"), { recursive: true });
    const added = [
      "replay/runtime/test-own-shell-new.mjs",
      "scoreboard/test-shell-scoreboard-new.ts",
    ];
    for (const file of added.concat([
      "replay/test-own-shell-browser.ts",
      "compat/own-shell-helper.mjs",
    ]))
      writeFileSync(resolve(directory, file), "");
    symlinkSync("replay/runtime", resolve(directory, "linked-replay"), "dir");
    const files = discoverScoreboardTests(directory).map((path) => relative(directory, path));
    assert.deepEqual(files, families.concat(added).sort());
  });
});
test("missing mandatory families and symlinked entrypoints fail closed", () => {
  fixture((directory) => {
    const link = resolve(directory, "compat/test-own-shell-link.mjs");
    symlinkSync("test-compat-selection.mjs", link);
    assert.throws(() => discoverScoreboardTests(directory), /regular files/);
    rmSync(link);
    rmSync(resolve(directory, "compat/test-compat-selection.mjs"));
    assert.throws(() => discoverScoreboardTests(directory), /empty scoreboard family/);
  });
});
test("a failing newly discovered test fails the actual runner", () => {
  fixture((directory) => {
    assert.equal(runScoreboardTests(directory).status, 0);
    writeFileSync(
      resolve(directory, "scoreboard/test-shell-scoreboard-failure.ts"),
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
