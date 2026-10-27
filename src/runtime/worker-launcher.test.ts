import assert from "node:assert/strict";
import { test } from "node:test";
import { guestArguments } from "./worker-launcher";

test("argv0 forwarding replaces only zero and leaves the caller's array untouched", () => {
  const original = ["python", "-c", "import sys; print(sys.argv)", "", "two words", "-x"];
  const forwarded = guestArguments(original, "/cross-build/wasm32-wasip1/python.wasm");
  assert.deepEqual(forwarded, ["/cross-build/wasm32-wasip1/python.wasm"].concat(original.slice(1)));
  assert.equal(original[0], "python");
  assert.notEqual(forwarded, original);
});

test("utilities without argv0 retain the original argument array identity", () => {
  const original = ["head", "-n", "2", "/input"];
  assert.equal(guestArguments(original), original);
  const empty: string[] = [];
  assert.equal(guestArguments(empty), empty);
});

test("explicit argv0 works with empty argv and an empty replacement", () => {
  assert.deepEqual(guestArguments([], "/program"), ["/program"]);
  assert.deepEqual(guestArguments(["original", "argument"], ""), ["", "argument"]);
});
