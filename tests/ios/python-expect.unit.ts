import { test } from "bun:test";
import assert from "node:assert/strict";
import { expect as playwrightExpect } from "@playwright/test";
import { pythonCases } from "../helpers/python-cases.ts";
import { createPythonExpectContext } from "./python-expect.ts";

function aggregate(context: ReturnType<typeof createPythonExpectContext>) {
  try {
    context.finish();
  } catch (error) {
    assert.ok(error instanceof AggregateError);
    return error;
  }
  return assert.fail("Expected collected soft failures");
}

function matcherErrors(error: AggregateError) {
  return Array.from(error.errors, (entry: unknown) => {
    assert.ok(entry instanceof Error);
    assert.ok("matcherResult" in entry);
    const result = entry.matcherResult;
    assert.ok(result && typeof result === "object");
    assert.ok("actual" in result && "expected" in result);
    assert.ok("name" in result && "pass" in result);
    assert.equal(result.name, "toBe");
    assert.equal(result.pass, false);
    assert.ok(entry.stack);
    return { error: entry, actual: result.actual, expected: result.expected };
  });
}

test("all 12 original examples continue through all 36 real soft matcher failures", async () => {
  const context = createPythonExpectContext();
  const completed: string[] = [];
  const messages: string[] = [];
  let bodyFinished = false;
  let finallyFinished = false;
  try {
    for (const example of pythonCases) {
      const result = { status: -1, stdout: `${example.stdout}!`, stderr: `${example.stderr}!` };
      const statusMessage = `${example.name}: ${result.stderr}`;
      context.expect.soft(result.status, statusMessage).toBe(example.status);
      context.expect.soft(result.stdout, example.name).toBe(example.stdout);
      context.expect.soft(result.stderr, example.name).toBe(example.stderr);
      messages.push(statusMessage, example.name, example.name);
      completed.push(example.name);
    }
    await context.expect.poll(() => completed.length).toBe(12);
    context.expect(completed).toEqual(pythonCases.map((example) => example.name));
    bodyFinished = true;
  } finally {
    finallyFinished = true;
  }
  const failure = aggregate(context);
  assert.equal(bodyFinished, true);
  assert.equal(finallyFinished, true);
  assert.equal(completed.length, 12);
  const errors = matcherErrors(failure);
  assert.equal(errors.length, 36);
  errors.forEach(({ error }, index) => {
    assert.ok(error.message.startsWith(`${messages[index]}\n\n`));
  });
});

test("mixed soft successes and failures use Object.is rather than equality booleans", () => {
  const context = createPythonExpectContext();
  const shared = { value: 1 };
  context.expect.soft(Number.NaN, "NaN equals itself").toBe(Number.NaN);
  context.expect.soft(shared, "same object").toBe(shared);
  context.expect.soft("", "empty output").toBe("");
  context.expect.soft(-0, "signed zero").toBe(0);
  context.expect.soft({ value: 1 }, "object identity").toBe(shared);
  context.expect.soft(7, "exit status").toBe(7);
  const errors = matcherErrors(aggregate(context));
  assert.equal(errors.length, 2);
  assert.ok(Object.is(errors[0]?.actual, -0));
  assert.equal(errors[1]?.expected, shared);
});

test("full 400000-byte stdout and 110000-byte stderr reach and survive the real matcher", () => {
  const context = createPythonExpectContext();
  const stdout = "0123456789".repeat(40000);
  const stderr = "diagnostic\n".repeat(10000);
  const actualStdout = `${stdout.slice(0, -1)}!`;
  const actualStderr = `${stderr.slice(0, -1)}!`;
  context.expect.soft(stdout, "complete stdout passes").toBe(stdout);
  context.expect.soft(stderr, "complete stderr passes").toBe(stderr);
  context.expect.soft(actualStdout, "complete stdout fails at the last byte").toBe(stdout);
  context.expect.soft(actualStderr, "complete stderr fails at the last byte").toBe(stderr);
  const errors = matcherErrors(aggregate(context));
  assert.equal(errors.length, 2);
  assert.equal(stdout.length, 400000);
  assert.equal(stderr.length, 110000);
  assert.equal(errors[0]?.actual, actualStdout);
  assert.equal(errors[0]?.expected, stdout);
  assert.equal(errors[1]?.actual, actualStderr);
  assert.equal(errors[1]?.expected, stderr);
  assert.ok(errors[0]?.error.message.includes(actualStdout));
  assert.ok(errors[0]?.error.message.includes(stdout));
});

test("custom messages and the original Error objects remain intact across finish calls", () => {
  const context = createPythonExpectContext();
  const message = "Python β: exact custom message\nwith a second line";
  context.expect.soft("actual", message).toBe("expected");
  const first = matcherErrors(aggregate(context));
  const second = matcherErrors(aggregate(context));
  assert.equal(first[0]?.error, second[0]?.error);
  assert.ok(first[0]?.error.message.startsWith(`${message}\n\n`));
  assert.ok(first[0]?.error.stack?.includes("python-expect.unit.ts"));
});

test("hard assertions remain immediate real Playwright failures outside the soft collection", () => {
  const context = createPythonExpectContext();
  assert.throws(
    () => context.expect(1, "hard status").toBe(2),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith("hard status\n\n"));
      assert.ok("matcherResult" in error);
      return true;
    },
  );
  assert.doesNotThrow(() => context.finish());
});

test("hard matcher exceptions keep their identity and still run the original finally", () => {
  const context = createPythonExpectContext();
  context.expect.soft(0, "earlier soft failure").toBe(7);
  const hardFailure = new Error("original hard matcher failure");
  const actual = {
    get value(): number {
      throw hardFailure;
    },
  };
  let finallyFinished = false;
  assert.throws(
    () => {
      try {
        context.expect(actual).toEqual({ value: 1 });
      } finally {
        finallyFinished = true;
      }
      context.finish();
    },
    (error: unknown) => error === hardFailure,
  );
  assert.equal(finallyFinished, true);
  assert.equal(matcherErrors(aggregate(context)).length, 1);
});

test("poll is the actual Playwright function with its defaults and options unchanged", async () => {
  const context = createPythonExpectContext();
  assert.equal(context.expect.poll, playwrightExpect.poll);
  let attempts = 0;
  await context.expect.poll(() => ++attempts).toBe(2);
  assert.equal(attempts, 2);
  await assert.rejects(
    context.expect.poll(() => 0, { message: "hard poll", timeout: 20, intervals: [1] }).toBe(1),
    /hard poll/,
  );
  const hardFailure = new Error("original poll callback failure");
  await assert.rejects(
    context.expect
      .poll(() => {
        throw hardFailure;
      })
      .toBe(1),
    (error: unknown) => error === hardFailure,
  );
  assert.doesNotThrow(() => context.finish());
});

test("independent contexts and the global Playwright expect do not share soft failures", () => {
  const originalSoft = Object.getOwnPropertyDescriptor(playwrightExpect, "soft");
  const originalPoll = playwrightExpect.poll;
  const first = createPythonExpectContext();
  const second = createPythonExpectContext();
  first.expect.soft("first", "first context").toBe("expected");
  second.expect.soft("same", "second context passes").toBe("same");
  assert.doesNotThrow(() => second.finish());
  assert.throws(() => playwrightExpect.soft("actual", "global stays unchanged").toBe("expected"));
  second.expect.soft("second", "second context fails").toBe("different");
  assert.equal(matcherErrors(aggregate(first)).length, 1);
  assert.equal(matcherErrors(aggregate(second)).length, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(playwrightExpect, "soft"), originalSoft);
  assert.equal(playwrightExpect.poll, originalPoll);
  assert.doesNotThrow(() => createPythonExpectContext().finish());
});
