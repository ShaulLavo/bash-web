import type { GitBranchConfig } from "../types";
import type { SegmentRenderer } from "./types";

function headLabel(
  head: NonNullable<
    NonNullable<Parameters<SegmentRenderer<GitBranchConfig>>[0]["repository"]>["head"]
  >,
): string {
  if (head.kind === "attached") return head.branch;
  if (head.kind === "detached") return "HEAD";
  return "?";
}

export const renderGitBranch: SegmentRenderer<GitBranchConfig> = (input, config) => {
  const head = input.repository?.head;
  if (config.disabled || !head) return undefined;
  if (head.kind === "detached" && config.onlyAttached) return undefined;
  const name = headLabel(head);
  if (config.ignoreBranches.includes(name)) return undefined;
  const branch = truncate(name, config.truncateLength, config.truncationSymbol);
  return [
    { text: config.prefix },
    { text: `${config.symbol}${branch}`, style: config.style },
    { text: config.suffix },
  ];
};

function truncate(value: string, length: number | undefined, symbol: string): string {
  if (length === undefined || value.length <= length) return value;
  const points = Array.from(value);
  if (points.length <= length) return value;
  const symbolPoints = Array.from(symbol);
  if (length <= symbolPoints.length) return symbolPoints.slice(0, length).join("");
  return `${points.slice(0, length - symbolPoints.length).join("")}${symbol}`;
}
