import { summarize } from "./shell-scoreboard.ts";
import type { Oracle, Score } from "./shell-scoreboard.ts";

export function frozenScore(oracle: Oracle, passes: readonly string[]): Score {
  const accepted = new Set(passes);
  const cases = oracle.cases.map(({ bash: _bash, ...item }) => {
    let outcome: "skip" | "pass" | "fail";
    if (item.excluded || item.kind !== "builtins-only") outcome = "skip";
    else outcome = accepted.has(item.id) ? "pass" : "fail";
    return { ...item, outcome };
  });
  return { engine: "own-shell", identity: oracle.identity, cases, counts: summarize({ cases }) };
}
