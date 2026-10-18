import type { RuntimeStartupStage } from "waffle";

// Keep runtime transport milestones distinct from the awaits they actually complete.
const runtimeStartupStages = [
  "filesystem-worker-created",
  "filesystem-connect-requested",
  "filesystem-connected",
  "indexeddb-open-requested",
  "indexeddb-open-resolved",
  "filesystem-lock-requested",
  "filesystem-lock-acquired",
  "filesystem-epoch-requested",
  "filesystem-epoch-resolved",
  "filesystem-ready",
] as const satisfies readonly RuntimeStartupStage[];
const runtimeStartupAwaits = [
  ["filesystem-connect-requested", "filesystem-connected"],
  ["indexeddb-open-requested", "indexeddb-open-resolved"],
  ["filesystem-lock-requested", "filesystem-lock-acquired"],
  ["filesystem-epoch-requested", "filesystem-epoch-resolved"],
] as const satisfies readonly (readonly [RuntimeStartupStage, RuntimeStartupStage])[];

const startupOperations = [
  "previous-stop",
  "terminal-open",
  "runtime-lease",
  "session-create",
  "test-guests-fetch",
  "test-guest-fetch",
  "test-guest-body",
  "test-spin-fetch",
  "test-spin-body",
  "test-guest-compile",
  "test-bin-mkdir",
  "test-programs-mkdir",
  "test-guest-bin-write",
  "test-guest-program-write",
  "test-spin-bin-write",
  "test-spin-program-write",
  "test-filesystem-drain",
  "shell-home-mkdir",
  "shell-tmp-mkdir",
  "shell-bin-mkdir",
  "shell-programs-mkdir",
  "shell-executable-lookup",
  "shell-executable-write",
  "shell-filesystem-drain",
  "shell-wasm-fetch",
  "shell-wasm-body",
  "shell-wasm-compile",
  "shell-registration",
  "shell-module",
  "shell-processes",
  "shell-root-adopt",
  "shell-supervisor",
  "shell-worker-start",
] as const;
export type StartupOperation = (typeof startupOperations)[number];
export type StartupStage = `${StartupOperation}-${"requested" | "resolved"}` | RuntimeStartupStage;
export type StartupObserver = (stage: StartupStage, timestamp: number) => void | PromiseLike<void>;

const startupAwaits: readonly (readonly [StartupStage, StartupStage])[] = startupOperations
  .map((operation): readonly [StartupStage, StartupStage] => [
    `${operation}-requested`,
    `${operation}-resolved`,
  ])
  .concat(runtimeStartupAwaits);
const allowedStages = new Set<string>(
  startupAwaits
    .flatMap(([requested, resolved]): string[] => [requested, resolved])
    .concat(runtimeStartupStages),
);

/** Observers never own startup work and cannot add an await or reject it. */
export function markStartup(observer: StartupObserver | undefined, stage: StartupStage): void {
  if (!observer) return;
  try {
    const result = observer(stage, performance.timeOrigin + performance.now());
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {}
}

export type StartupSnapshot = {
  generation: number;
  stages: Partial<Record<StartupStage, number>>;
  pending: StartupStage[];
  last: { stage: StartupStage; timestamp: number } | undefined;
};

/** One timestamp per fixed stage, isolated from callbacks belonging to a stopped generation. */
export function createStartupDiagnostics(generation: number) {
  const stages: StartupSnapshot["stages"] = {};
  let last: StartupSnapshot["last"];
  let active = true;
  const observe: StartupObserver = (stage, timestamp) => {
    if (
      !active ||
      !allowedStages.has(stage) ||
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      stages[stage] !== undefined
    )
      return;
    stages[stage] = timestamp;
    if (!last || timestamp >= last.timestamp) last = { stage, timestamp };
  };
  return {
    observe,
    stop() {
      active = false;
    },
    snapshot(): StartupSnapshot {
      const pending = startupAwaits
        .filter(
          ([requested, resolved]) =>
            stages[requested] !== undefined && stages[resolved] === undefined,
        )
        .map(([requested]) => requested);
      return { generation, stages: { ...stages }, pending, last: last && { ...last } };
    },
  };
}
