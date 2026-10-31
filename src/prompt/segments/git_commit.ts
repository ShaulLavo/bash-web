import type { GitCommitConfig } from "../types";
import type { SegmentRenderer } from "./types";

export const renderGitCommit: SegmentRenderer<GitCommitConfig> = (input, config) => {
  const repository = input.repository;
  if (config.disabled || !repository || repository.head.kind !== "detached") return undefined;
  const commit = repository.head.commit.slice(0, config.length);
  return [
    { text: config.prefix },
    { text: `(${commit})`, style: config.style },
    { text: config.suffix },
  ];
};
