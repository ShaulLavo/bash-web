import { digest, sealOracle, summarize } from "./shell-scoreboard.mjs";

export function scoreboardFixture(corpus) {
  const oracle = sealOracle({
    schema: 1,
    oracle: {},
    environment: {},
    sources: {},
    cases: ["a", "x", "y", "brush-suite:compound_cmds/until:8"].map((id) => ({
      id,
      corpus,
      category: "control",
      kind: "builtins-only",
      bash: {},
    })),
  });
  function score(passes, timeout = false) {
    const cases = oracle.cases.map(({ bash: _bash, ...item }) => ({
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
  function floor(ids, sourceSha = "a".repeat(40)) {
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
