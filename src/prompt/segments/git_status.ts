import type { Piece } from "../compose";
import type { GitStatusConfig } from "../types";
import type { SegmentInput } from "./types";
import type { StatusCounts } from "../sources/status-types";

export function renderGitStatus(input: SegmentInput, config: GitStatusConfig): Piece[] | undefined {
  if (config.disabled || !input.repository || !input.gitStatus) return undefined;
  const { value, stale } = input.gitStatus;
  if (value.worktree.kind === "unknown") return unknown(config);
  const counts = value.worktree.value;
  let text = marker(counts.conflicted, config.conflicted, config.counts);
  const stash = input.repository.stash;
  if (stash.present === undefined) return unknown(config);
  if (stash.present)
    text += marker(stash.count ?? 1, config.stashed, config.counts && stash.count !== undefined);
  const kinds: readonly (keyof StatusCounts)[] = [
    "deleted",
    "modified",
    "typeChanged",
    "untracked",
  ];
  for (const kind of kinds) text += marker(counts[kind], config[kind], config.counts);
  if (value.objects) {
    const { staged, aheadBehind } = value.objects;
    if (staged.kind === "unknown" || aheadBehind.kind === "unknown") return unknown(config);
    text += marker(staged.value, config.staged, config.counts);
    text += marker(counts.untracked, config.untracked, config.counts);
    const { ahead, behind } = aheadBehind.value;
    text +=
      ahead && behind
        ? config.diverged + (config.counts ? `${ahead}/${behind}` : "")
        : marker(ahead, config.ahead, config.counts) + marker(behind, config.behind, config.counts);
  }
  if (!value.objects) text += marker(counts.untracked, config.untracked, config.counts);
  if (!text) return undefined;
  return [
    {
      text: `${config.prefix}[${text}]${config.suffix}`,
      style: stale ? { ...config.style, dim: true } : config.style,
    },
  ];
}
function marker(count: number, symbol: string, counts: boolean): string {
  return count && symbol ? symbol + (counts ? count : "") : "";
}
function unknown(config: GitStatusConfig): Piece[] {
  return [
    {
      text: `${config.prefix}[${config.unknown}]${config.suffix}`,
      style: { ...config.style, dim: true },
    },
  ];
}
