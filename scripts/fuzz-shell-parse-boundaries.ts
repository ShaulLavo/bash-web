#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Case = { name: string; layout: number; form: number; script: string };
type Observation = { status: number | null; stdoutBase64: string };
type FixtureCase = Case & { bash: Observation };
type Fixture = { sourceHash: string; bash: string; cases: FixtureCase[] };

const options: Record<string, string | undefined> = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, index) => [
    process.argv[index * 2 + 2],
    process.argv[index * 2 + 3],
  ]),
);
const shell = resolve(options["--shell"] ?? ".build/shell/release/shell-engine");
const sourceHash = createHash("sha256")
  .update(readFileSync(import.meta.filename))
  .digest("hex");
const cases: Case[] = ["a", "empty_word", "_drop7"].flatMap((name, nameIndex) =>
  [" ", "\t", " \\\n  "].flatMap((blank, layout) =>
    ["= 0", "+= 1", "= 2 * 3"].map((operation, form) => {
      const variable = `value_${nameIndex}_${layout}_${form}`;
      const newline = ["\n", "\n\n", "\n# between read units\n"][layout];
      return {
        name,
        layout,
        form,
        script: `shopt -s expand_aliases${newline}alias ${name}=${newline}${name}${blank}(( ${variable} ${operation} ))${newline}printf '%s\\n' done "$${variable}"`,
      };
    }),
  ),
);
const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "BASH_COMPAT", "POSIXLY_CORRECT"])
  delete env[name];
function run(binary: string, args: string[]): Observation {
  const result = spawnSync(binary, args, { env, timeout: 2000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return { status: result.status, stdoutBase64: result.stdout.toString("base64") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isObservation(value: unknown): value is Observation {
  if (!isRecord(value)) return false;
  return (
    (typeof value.status === "number" || value.status === null) &&
    typeof value.stdoutBase64 === "string"
  );
}

function isFixtureCase(value: unknown, expected: Case): value is FixtureCase {
  if (!isRecord(value) || !isObservation(value.bash)) return false;
  const { bash: _bash, ...actual } = value;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseFixture(value: unknown): Fixture {
  if (!isRecord(value) || !Array.isArray(value.cases)) throw new Error("invalid fixture");
  if (typeof value.sourceHash !== "string" || typeof value.bash !== "string")
    throw new Error("invalid fixture identity");
  if (
    value.cases.length !== cases.length ||
    !value.cases.every((entry, index) => isFixtureCase(entry, cases[index]))
  )
    throw new Error("fixture cases differ");
  return { sourceHash: value.sourceHash, bash: value.bash, cases: value.cases };
}

const fixture = options["--replay"]
  ? parseFixture(JSON.parse(readFileSync(options["--replay"], "utf8")))
  : {
      sourceHash,
      bash: execFileSync("bash", ["--version"], { encoding: "utf8" }).split("\n", 1)[0],
      cases: cases.map((test) => ({
        ...test,
        bash: run("bash", ["--noprofile", "--norc", "-c", test.script]),
      })),
    };
assert.match(fixture.bash, /^GNU bash, version 5\.3\.15\(/);
assert.equal(fixture.sourceHash, sourceHash);
assert.deepEqual(
  fixture.cases.map(({ bash, ...test }) => test),
  cases,
);
const mismatches = fixture.cases.flatMap((test) => {
  const actual = run(shell, ["-c", test.script]);
  return JSON.stringify(actual) === JSON.stringify(test.bash) ? [] : [{ ...test, actual }];
});
console.log(JSON.stringify({ total: cases.length, mismatches }, null, 2));
assert.equal(mismatches.length, 0);
if (options["--record"])
  writeFileSync(options["--record"], JSON.stringify(fixture, null, 2) + "\n");
