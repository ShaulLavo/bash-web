import { summarize } from "./shell-scoreboard.ts";
import type { Oracle, Score } from "./shell-scoreboard.ts";

export function frozenScore(oracle: Oracle, passes: readonly string[]): Score {
  const accepted = new Set(passes);
  const cases = oracle.cases.map(({ bash: _bash, ...item }) => ({
    ...item,
    outcome:
      item.excluded || item.kind !== "builtins-only"
        ? "skip"
        : accepted.has(item.id)
          ? "pass"
          : "fail",
  }));
  return { engine: "own-shell", identity: oracle.identity, cases, counts: summarize({ cases }) };
}
