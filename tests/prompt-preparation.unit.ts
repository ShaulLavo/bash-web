import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptProvider, PromptStart } from "../src/index";

test("public prompt preparation accepts the exported startup type", () => {
  const start: PromptStart = { cwd: "/project", env: { MODE: "test" } };
  const prepared: PromptStart[] = [];
  const provider: PromptProvider = {
    variables: [],
    prepare(value) {
      prepared.push(value);
    },
    render() {
      return null;
    },
  };
  provider.prepare?.(start);
  assert.deepEqual(prepared, [start]);
});
