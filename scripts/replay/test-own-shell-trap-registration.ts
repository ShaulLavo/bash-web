import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseShellRunner } from "../build/release-shell-runner.ts";

const run = await releaseShellRunner();

for (const event of ["EXIT", "ERR", "RETURN", "DEBUG", "INT", "TERM", "HUP", "QUIT"]) {
  test(`trap rejects ${event} without retaining a handler`, async () => {
    const result = await run(`trap 'echo forbidden' ${event}; code=$?; trap -p; exit "$code"`);
    assert.deepEqual(
      [result.status, result.stdout.toString(), result.stderr.toString(), result.crash],
      [1, "", `trap: ${event}: trap execution is unsupported\n`, undefined],
    );
  });
}

test("trap lists signals and permits read-only queries", async () => {
  const result = await run("trap -p EXIT INT; trap -P EXIT; trap -l");
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /\bSIGINT\b/);
  assert.equal(result.stderr.toString(), "");
});

test("trap keeps KILL and STOP registrations queryable", async () => {
  const result = await run(
    "trap : 9 && trap : KILL && trap : STOP && trap -p && trap - KILL STOP && trap -p",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "trap -- ':' SIGKILL\ntrap -- ':' SIGSTOP\n");
  assert.equal(result.stderr.toString(), "");
});

test("trap rejects TERM and EXIT in a registration that also names KILL and STOP", async () => {
  const result = await run(`
    trap : KILL TERM EXIT STOP
    code=$?
    trap -p
    exit "$code"
  `);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.toString(), "trap -- ':' SIGKILL\ntrap -- ':' SIGSTOP\n");
  assert.equal(
    result.stderr.toString(),
    "trap: TERM: trap execution is unsupported\ntrap: EXIT: trap execution is unsupported\n",
  );
});

test("a failed registration preserves inherited uncatchable bindings", async () => {
  const result = await run(`
    trap : KILL
    (trap 'echo forbidden' TERM; code=$?; trap -p; exit "$code")
  `);
  assert.deepEqual(
    [result.status, result.stdout.toString(), result.stderr.toString()],
    [1, "trap -- ':' SIGKILL\n", "trap: TERM: trap execution is unsupported\n"],
  );
});
