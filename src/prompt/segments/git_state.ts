import type { GitStateConfig } from "../types";
import type { SegmentRenderer } from "./types";
import type { GitOperation } from "../sources/repo-types";

export const renderGitState: SegmentRenderer<GitStateConfig> = (input, config) => {
  const operation = input.repository?.operation;
  if (config.disabled || !operation) return undefined;
  return [
    { text: config.prefix },
    { text: operationText(operation), style: config.style },
    { text: config.suffix },
  ];
};

function operationText(operation: GitOperation): string {
  if (operation.kind !== "rebase" && operation.kind !== "am")
    return operationLabels[operation.kind];
  const progress = operation.progress;
  const label = operation.kind === "am" ? "AM" : "REBASING";
  return progress ? `${label} ${progress.current}/${progress.total}` : label;
}

const operationLabels: Record<Exclude<GitOperation, { kind: "rebase" | "am" }>["kind"], string> = {
  unknown: "?",
  merge: "MERGING",
  "cherry-pick": "CHERRY-PICKING",
  revert: "REVERTING",
  bisect: "BISECTING",
};
