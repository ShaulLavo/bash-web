import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseShellRunner } from "../build/release-shell-runner.ts";
import { recordedBashTests } from "./recorded-bash-tests.ts";

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

for (const action of ["-", ":"]) {
  test(`invalid signal names preserve the inherited reset for trap ${action}`, async () => {
    const result = await run(`
      trap : KILL
      (trap ${action} BAD; code=$?; trap -p KILL; exit "$code")
    `);
    assert.deepEqual(
      [result.status, result.stdout.toString(), result.stderr.toString()],
      [1, "", "trap: BAD: invalid signal specification\n"],
    );
  });
}

for (const operand of ["TERM", "BAD"]) {
  test(`trap still registers KILL when the ${operand} diagnostic cannot be written`, async () => {
    const result = await run(`
      printf x >/tmp/unwritable-stderr
      trap : ${operand} KILL 2</tmp/unwritable-stderr
      code=$?
      trap -p KILL
      exit "$code"
    `);
    assert.deepEqual(
      [result.status, result.stdout.toString(), result.stderr.toString()],
      [1, "trap -- ':' SIGKILL\n", ""],
    );
  });
}

// These frozen observations cover queries, resets, invalid arguments, and uncatchable bindings.
await recordedBashTests(
  "trap",
  new URL("../fixtures/shell-trap-registration.json", import.meta.url),
  new Set([
    "empty",
    "one-operand",
    "options",
    "list",
    "kill-stop",
    "invalid-prefixed-event",
    "r1:rtmax-offset",
    "r1:numeric-one-action",
    "r1:query-mutually-exclusive-noargs",
    "r1:query-mutually-exclusive-list",
    "r1:list-option-priority",
    "r1:root-no-trap-errexit",
    "r1:root-no-trap-eval",
    "r1:rtmin-alias-31",
    "r1:rtmax-alias-0",
    "r1:rtmax-alias-15",
    "r1:rtmax-alias-16",
    "r1:rtmax-alias-20",
    "r1:rtmax-alias-29",
    "r1:rtmax-alias-30",
    "r1:rtmax-alias-31",
    "r1:numeric-alias--2",
    "r1:no-trap-explicit-exit",
    "unrecorded-aliases",
    "unrecorded-prefixed-aliases",
    "numeric-placeholder-registration-rejected",
    "number-'\\xa02'",
    "number-'2\\xa0'",
    "nested-parent-deferred-handler-9",
    "nested-parent-deferred-handler-19",
  ]),
);
