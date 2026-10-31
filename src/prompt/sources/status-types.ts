import type { renderGitStatus } from "../segments/git_status";
import type { TurnFilesystem } from "../fs";
import type { WorkBudget } from "../live";
import type { GitStatusConfig, PromptContext } from "../types";
import type { Known, ObjectStatus, ParsedIndex } from "./index-types";
import type { RepositorySnapshot } from "./repo-types";

export interface StatusCounts {
  readonly conflicted: number;
  readonly deleted: number;
  readonly modified: number;
  readonly typeChanged: number;
  readonly untracked: number;
}
interface StatusValue {
  readonly worktree: Known<StatusCounts>;
  readonly objects?: ObjectStatus;
}
export interface StatusSnapshot {
  readonly value: StatusValue;
  readonly stale: boolean;
}
export interface StatusRequest {
  readonly filesystem: TurnFilesystem;
  readonly repository: RepositorySnapshot;
  readonly context: PromptContext;
  readonly config: GitStatusConfig;
  readonly budget: WorkBudget;
  readonly stale: (snapshot: StatusSnapshot) => void;
}
export interface StatusSource {
  read(request: StatusRequest): Promise<StatusSnapshot>;
  leave(): void;
}
export interface StatusLoader {
  load(): Promise<{ readonly source: StatusSource; readonly render: typeof renderGitStatus }>;
  leave(): void;
}
export type ObjectReader = (
  filesystem: TurnFilesystem,
  repository: RepositorySnapshot,
  index: ParsedIndex,
  budget: WorkBudget,
) => Promise<ObjectStatus>;
