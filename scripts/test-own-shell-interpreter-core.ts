import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { stopNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

type Recording = {
  schema: number;
  bash: string;
  cases: { id: string; script: string; bash: { status: number; stdout: string } }[];
};
const fixture: Recording = JSON.parse(
  readFileSync(new URL("fixtures/shell-interpreter-core.json", import.meta.url), "utf8"),
);
assert.equal(fixture.schema, 1);
assert.equal(fixture.bash, "5.3.15(1)-release");
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const runner = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: "/tmp/spec",
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
});
after(stopNodeWorkers);

async function run(script: string) {
  const actual = await runner(script);
  assert.equal(actual.crash, undefined, script);
  assert.equal(actual.outputLimit, undefined, script);
  return actual;
}

// Timing reports and diagnostics go to stderr, so the Bash recording covers status and stdout.
for (const entry of fixture.cases)
  test(`production Waffle interpreter core: ${entry.id}`, { timeout: 10000 }, async (context) => {
    context.signal.addEventListener("abort", () => void stopNodeWorkers(), { once: true });
    const actual = await run(entry.script);
    assert.deepEqual(
      [actual.status, actual.stdout.toString("base64")],
      [entry.bash.status, entry.bash.stdout],
      entry.script,
    );
  });

// Without CPU accounting the reports carry real time only, never invented zeros.
for (const [script, report] of [
  ["time true", /^\nreal\t0m\d\.\d{3}s\n$/],
  ["time -p true", /^real \d+\.\d{2}\n$/],
  ["TIMEFORMAT='%6R'; time true", /^\d+\.\d{6}\n$/],
  ["TIMEFORMAT='%U'; time true", /^\/usr\/bin\/bash: TIMEFORMAT: `U': CPU time is unavailable\n$/],
  ["TIMEFORMAT='%X'; time true", /^\/usr\/bin\/bash: TIMEFORMAT: `X': invalid format character\n$/],
] as const)
  test(`production Waffle time report: ${script}`, { timeout: 10000 }, async (context) => {
    context.signal.addEventListener("abort", () => void stopNodeWorkers(), { once: true });
    const actual = await run(script);
    assert.equal(actual.status, 0, script);
    assert.equal(actual.stdout.length, 0, script);
    assert.match(actual.stderr.toString(), report, script);
  });
