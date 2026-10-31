export type GitOperation =
  | {
      readonly kind: "rebase" | "am";
      readonly progress?: { readonly current: number; readonly total: number };
    }
  | { readonly kind: "merge" | "cherry-pick" | "revert" | "bisect" | "unknown" };

export type RepositoryHead =
  | { readonly kind: "attached"; readonly branch: string; readonly commit: string | undefined }
  | { readonly kind: "detached"; readonly commit: string }
  | { readonly kind: "unknown" };

export interface RepositorySnapshot {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly head: RepositoryHead;
  readonly operation: GitOperation | undefined;
  readonly stash: { readonly present: boolean | undefined; readonly count?: number };
  readonly config: string | undefined;
}
