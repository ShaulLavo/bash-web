/** SHA-1 index entries, shared with the lazy object reader. Paths are repository-relative. */
export interface IndexEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: number;
  readonly stage: number;
  readonly assumeValid: boolean;
  readonly skipWorktree: boolean;
  readonly intentToAdd: boolean;
  readonly mtimeMs: number;
}

export interface ParsedIndex {
  readonly entries: readonly IndexEntry[];
}

export type Known<T> = { readonly kind: "known"; readonly value: T } | { readonly kind: "unknown" };

export interface ObjectStatus {
  readonly staged: Known<number>;
  readonly aheadBehind: Known<{ readonly ahead: number; readonly behind: number }>;
}
