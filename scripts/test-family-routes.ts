import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { basePrograms } from "waffle-base";
import { familyWasmPath } from "./family-assets.ts";

test("all 24 canonical published programs have existing guest routes", () => {
  assert.equal(basePrograms.length, 24);
  const names = basePrograms.map((program) =>
    program.path.slice(program.path.lastIndexOf("/") + 1),
  );
  assert.equal(new Set(names).size, 24);
  for (const name of names) assert.ok(existsSync(familyWasmPath(name)), name);
  assert.throws(() => familyWasmPath("not-a-published-program"), /Unknown family program/);
});
