import { digest, sealOracle, summarize } from "./shell-scoreboard.ts";
import type { Score, ScoreCase } from "./shell-scoreboard.ts";
import type { MainFloor } from "./shell-scoreboard-floor.ts";

export function scoreboardFixture(
  corpus: string,
  ids: readonly string[] = ["a", "x", "y", "brush-suite:compound_cmds/until:8"],
) {
  const oracle = sealOracle({
    schema: 1,
    oracle: {},
    environment: {},
    sources: {},
    cases: ids.map((id) => ({
      id,
      corpus,
      category: "control",
      kind: "builtins-only",
      bash: {},
    })),
  });
  function score(passes: string[], timeout = false): Score {
    const cases: ScoreCase[] = oracle.cases.map(({ bash: _bash, ...item }) => ({
      ...item,
      outcome: passes.includes(item.id)
        ? "pass"
        : timeout && item.id.endsWith("until:8")
          ? "timeout"
          : "fail",
      ...(timeout && item.id.endsWith("until:8")
        ? { actual: { stdout: "", stderr: "", timeout: true } }
        : {}),
    }));
    return { engine: "own-shell", identity: oracle.identity, cases, counts: summarize({ cases }) };
  }
  function floor(ids: string[], sourceSha = "a".repeat(40)): MainFloor {
    return {
      schema: 1,
      kind: "main-floor",
      sourceSha,
      identity: oracle.identity,
      floorIds: ids.toSorted(),
      floorSha256: digest(ids.toSorted()),
      evidence: [],
    };
  }
  return { oracle, score, floor };
}
