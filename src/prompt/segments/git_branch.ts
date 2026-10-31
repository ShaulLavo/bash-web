import type { GitBranchConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderGitBranch: SegmentRenderer<GitBranchConfig> = (input, config) => {
  const head = input.repository?.head;
  if (config.disabled || !head) return undefined;
  if (head.kind === "detached" && config.onlyAttached) return undefined;
  const name = head.kind === "attached" ? head.branch : head.kind === "detached" ? "HEAD" : "?";
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
  if (length <= symbol.length) return symbol.slice(0, length);
  return `${value.slice(0, length - symbol.length)}${symbol}`;
}
