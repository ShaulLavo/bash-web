import assert from "node:assert/strict";
import { test } from "node:test";
import { UtilityConflictError } from "../src/index";

test("the public utility conflict error retains its path and reason", () => {
  const error = new UtilityConflictError("/bin/sh", "another entry already exists");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "UtilityConflictError");
  assert.equal(error.path, "/bin/sh");
  assert.equal(error.message, "Cannot install utility at /bin/sh: another entry already exists");
});
