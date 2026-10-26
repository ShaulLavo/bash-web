import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileUtilityCases, type FileTree } from "../tests/helpers/file-utility-cases.ts";

type Observation = { status: number; stdout: number[]; stderr: boolean; tree: FileTree };
const fixture: {
  schema: number;
  bash: { version: string };
  cases: { name: string; script: string; result: Observation; diagnosticBytes: number[] }[];
} = JSON.parse(
  readFileSync(new URL("./owned-fixtures/file-utilities.json", import.meta.url), "utf8"),
);
assert.equal(fixture.schema, 1);
assert.match(fixture.bash.version, /^GNU bash, version 5\.3\.15\(1\)-release /);
assert.deepEqual(
  fixture.cases.map(({ name, script }) => ({ name, script })),
  fileUtilityCases,
);
export function fileUtilityObservation(script: string): Observation {
  const example = fixture.cases.find((entry) => entry.script === script);
  assert.ok(example, `Missing frozen file utility observation: ${script}`);
  return example.result;
}
