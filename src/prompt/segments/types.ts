import type { renderGitStatus } from "./git_status";
import type { StatusSnapshot } from "../sources/status-types";
import type { RepositorySnapshot } from "../sources/repo-types";
import type { PromptContext, VersionMap } from "../types";
import type { Piece } from "../compose";

export interface DirectorySnapshot {
  readonly path: string;
  readonly names: ReadonlySet<string>;
}

export interface ManifestSnapshot {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
}

export interface SegmentInput {
  readonly context: PromptContext;
  readonly directory: DirectorySnapshot | undefined;
  readonly manifest: ManifestSnapshot | undefined;
  readonly repository: RepositorySnapshot | undefined;
  readonly gitStatus?: StatusSnapshot;
  readonly statusRenderer?: typeof renderGitStatus;
  readonly versions: VersionMap;
}

export type SegmentRenderer<C> = (input: SegmentInput, config: C) => Piece[] | undefined;
