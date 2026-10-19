import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cases, validateFixture } from "./fuzz-shell-echo.ts";

test("echo controls retain option boundaries and raw escape observations", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("fixtures/shell-echo.json", import.meta.url), "utf8"),
  );
  assert.equal(validateFixture(fixture).length, cases().length);
  const changed = structuredClone(fixture);
  changed.cases[0].case.script = "true";
  assert.throws(() => validateFixture(changed));
  const broken = structuredClone(fixture);
  broken.cases[0].bash.timedOut = true;
  assert.throws(() => validateFixture(broken));
  const invalidBytes = structuredClone(fixture);
  invalidBytes.cases[0].bash.stdoutBase64 = "not base64";
  assert.throws(() => validateFixture(invalidBytes));
});
