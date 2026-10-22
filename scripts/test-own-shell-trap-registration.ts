import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

type Fixture = {
  version: string;
  cases: { id: string; code: string; status: number; stdout: string; stderr: string }[];
};
const fixture: Fixture = JSON.parse(
  readFileSync(new URL("fixtures/shell-trap-registration.json", import.meta.url), "utf8"),
);
assert.match(fixture.version, /^GNU bash, version 5\.3\.15\(/u);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  fixtureDirectory: directory,
  utilityDirectory: directory,
  tmp: "/tmp/spec",
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
});
for (const entry of fixture.cases) {
  test(`recorded Bash trap: ${entry.id}`, async () => {
    const result = await run(entry.code);
    assert.equal(result.crash, undefined);
    assert.equal(result.status, entry.status);
    assert.equal(result.stdout.toString(), entry.stdout);
    if (entry.stderr === "") assert.equal(result.stderr.toString(), "");
  });
}
