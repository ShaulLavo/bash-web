import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "./compose";
import { resolvePromptConfig } from "./config/defaults";
import { context } from "./git-test-helpers";

function renderBranch(branch: string, truncateLength?: number, truncationSymbol = "…"): string {
  return composePrompt({
    context: context("/repo"),
    config: resolvePromptConfig({
      newline: false,
      layout: ["git_branch"],
      segments: {
        git_branch: { prefix: "", symbol: "", suffix: "", truncateLength, truncationSymbol },
      },
    }),
    repository: {
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      head: { kind: "attached", branch, commit: undefined },
      operation: undefined,
      stash: { present: false },
      config: undefined,
    },
    directory: undefined,
    manifest: undefined,
    versions: {},
    environment: { noColor: true },
  });
}

test("branch truncation keeps supplementary characters intact", () => {
  const result = renderBranch("😀ab", 2);
  assert.equal(result, "😀…");
  assert.ok(result.isWellFormed());
});

test("truncation clips supplementary symbols at code-point boundaries", () => {
  const result = renderBranch("long", 1, "😀!");
  assert.equal(result, "😀");
  assert.ok(result.isWellFormed());
});

test("a branch at the exact code-point limit remains unchanged", () => {
  assert.equal(renderBranch("😀a", 2), "😀a");
  assert.equal(renderBranch("😀a"), "😀a");
});

test("branch truncation retains ASCII and BMP behavior", () => {
  assert.equal(renderBranch("abcd", 3), "ab…");
  assert.equal(renderBranch("é漢字", 2), "é…");
  assert.equal(renderBranch("abc", 0), "");
  assert.equal(renderBranch("abcd", 2, ""), "ab");
  assert.equal(renderBranch("abcd", 2, "XYZ"), "XY");
});

test("branch truncation counts code points rather than graphemes", () => {
  assert.equal(renderBranch("e\u0301ab", 2), "e…");
});
