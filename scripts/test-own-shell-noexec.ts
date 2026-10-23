import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { stopNodeWorkers } from "./node-worker-host.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

type Recording = {
  schema: number;
  bash: string;
  cases: {
    id: string;
    script: string;
    bash: { status: number; stdout: string; stderr: string };
  }[];
};
const fixture: Recording = JSON.parse(
  readFileSync(new URL("fixtures/shell-noexec.json", import.meta.url), "utf8"),
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

for (const entry of fixture.cases)
  test(`production Waffle noexec: ${entry.id}`, async () => {
    const actual = await runner(entry.script);
    assert.equal(actual.crash, undefined, entry.script);
    assert.equal(actual.outputLimit, undefined, entry.script);
    assert.deepEqual(
      [actual.status, actual.stdout.toString("base64"), actual.stderr.toString("base64")],
      [entry.bash.status, entry.bash.stdout, entry.bash.stderr],
      entry.script,
    );
  });
