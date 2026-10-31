import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

import fixture from "./fixtures/shell-mapfile.json" with { type: "json" };
assert.equal(fixture.bash, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
const run = await releaseShellRunner(fixture.env);
for (const item of fixture.cases)
  test(`production Waffle mapfile ${item.id}`, async () => {
    const actual = await run(item.script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, item.status, item.script);
    assert.deepEqual(actual.stdout, Buffer.from(item.stdoutBase64, "base64"), item.script);
  });

for (const overlay of [false, true])
  test(`production Waffle interrupted mapfile retains ${overlay ? "overlay" : "replacement"} prefix`, async () => {
    const { api, runInteractive } = await import("./own-shell-interactive.ts");
    const encoder = new TextEncoder();
    let phase = 0;
    let status = 0;
    let step = 0;
    let kill = () => {};
    const result = runInteractive({
      args: ["shell-runtime"],
      terminal(guest) {
        kill = () => guest.kill(2);
        return {
          inherited_fd: (index: number) => [0, 1, 2][index] ?? -1,
          columns: () => 80,
          rows: () => 24,
          phase(next: number, code: number) {
            phase = next;
            status = code;
          },
          ...api.noPromptHost,
        };
      },
      next(output) {
        step++;
        switch (step) {
          case 1:
            assert.equal(phase, 1);
            return encoder.encode(`a=(o0 o1 o2 o3); mapfile -t ${overlay ? "-O 1 " : ""}a\r`);
          case 2:
            assert.equal(phase, 2);
            return encoder.encode("first\nsecond\nunfinished");
          case 3:
            assert.equal(phase, 2);
            kill();
            return undefined;
          case 4:
            assert.equal(phase, 1);
            assert.equal(status, 130);
            return encoder.encode("printf '\\nPREFIX<%s>\\n' \"${a[@]}\"\r");
          case 5:
            assert.equal(phase, 1);
            assert.equal(status, 0);
            assert.ok(output.includes("\nPREFIX<first>\n"), output);
            assert.ok(output.includes("\nPREFIX<second>\n"), output);
            assert.ok(!output.includes("\nPREFIX<unfinished>\n"), output);
            assert.equal(output.includes("\nPREFIX<o0>\n"), overlay, output);
            assert.equal(output.includes("\nPREFIX<o3>\n"), overlay, output);
            return encoder.encode("exit 0\r");
          default:
            throw new Error("Unexpected extra interactive read");
        }
      },
    });
    assert.equal(result.status, 0, result.errors);
    assert.equal(step, 5);
    assert.ok(result.inputClosed);
  });
