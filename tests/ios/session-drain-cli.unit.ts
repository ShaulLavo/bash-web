import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const entry = resolve(root, "scripts/test-session-drain-ios.ts");

function invoke(args: readonly string[]) {
  return spawnSync(process.execPath, [entry].concat(args), {
    cwd: root,
    env: { ...process.env, IOS_UDID: "" },
    encoding: "utf8",
    timeout: 10_000,
  });
}

for (const args of [[], ["--result", "relative.json"], ["--unknown"]]) {
  test(`native wrapper retains public argument rejection: ${JSON.stringify(args)}`, () => {
    const result = invoke(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /Usage:/);
  });
}

test("native wrapper delegates preconditions and writes no passing suite credit", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "drain-cli-"));
  try {
    const resultPath = resolve(scratch, "result.json");
    const result = invoke(["--result", resultPath]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.ok(existsSync(resultPath));
    const returned: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.deepEqual(returned, {
      suite: "bash-session-drain",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
