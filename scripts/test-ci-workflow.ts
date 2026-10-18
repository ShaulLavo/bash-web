import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("the existing shell check stays red if any producer or moved check fails or skips", () => {
  const workflow: unknown = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.ok(workflow && typeof workflow === "object" && "jobs" in workflow);
  const jobs = workflow.jobs;
  assert.ok(jobs && typeof jobs === "object" && "shell" in jobs);
  const shell = jobs.shell;
  assert.ok(
    shell && typeof shell === "object" && "needs" in shell && "if" in shell && "steps" in shell,
  );
  assert.deepEqual(
    shell.needs,
    Object.keys(jobs).filter((key) => key !== "shell"),
  );
  assert.equal(shell.if, "always()");
  assert.ok(Array.isArray(shell.steps));
  assert.equal(shell.steps.length, 1);
  const gate: unknown = shell.steps[0];
  assert.ok(gate && typeof gate === "object" && "run" in gate && typeof gate.run === "string");
  assert.match(gate.run, /needs\.\*\.result/);
  assert.match(gate.run, /!= 'success'/);
  assert.match(gate.run, /exit 1/);
});
