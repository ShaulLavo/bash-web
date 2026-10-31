import type { RuntimeFilesystem } from "waffle";

export type PromptFilesystem = Pick<RuntimeFilesystem, "lookup" | "readFile">;

export type { PromptContext, PromptLive, PromptProvider, PromptStart } from "../index";

export type VersionMap = Readonly<{
  readonly bun?: string;
  readonly node?: string;
  readonly python?: string;
}>;

export type SegmentName =
  | "directory"
  | "git_branch"
  | "git_commit"
  | "git_state"
  | "git_status"
  | "package"
  | "bun"
  | "nodejs"
  | "python"
  | "env_var"
  | "cmd_duration"
  | "jobs"
  | "status"
  | "line_break"
  | "character";

export type SegmentStyle = {
  readonly fg?: Color;
  readonly bg?: Color;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strike?: boolean;
};

export type Color = string | number;

export type LayoutItem = SegmentName | { readonly text: string; readonly style?: SegmentStyle };

export interface DirectoryConfig {
  readonly disabled: boolean;
  readonly style: SegmentStyle;
  readonly truncationLength: number;
  readonly truncationSymbol: string;
  readonly homeSymbol: string;
  readonly suffix: string;
  readonly repoRootStyle: SegmentStyle;
}
export interface GitBranchConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly symbol: string;
  readonly style: SegmentStyle;
  readonly suffix: string;
  readonly truncateLength?: number;
  readonly truncationSymbol: string;
  readonly onlyAttached: boolean;
  readonly ignoreBranches: readonly string[];
}
export interface GitCommitConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly suffix: string;
  readonly style: SegmentStyle;
  readonly length: number;
}
export interface GitStateConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly suffix: string;
  readonly style: SegmentStyle;
}
export interface GitStatusConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly suffix: string;
  readonly style: SegmentStyle;
}
export interface PackageConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly symbol: string;
  readonly style: SegmentStyle;
  readonly suffix: string;
  readonly showPrivate: boolean;
}
export interface BunConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly symbol: string;
  readonly style: SegmentStyle;
  readonly suffix: string;
}
export interface NodejsConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly symbol: string;
  readonly style: SegmentStyle;
  readonly suffix: string;
}
export interface PythonConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly symbol: string;
  readonly style: SegmentStyle;
  readonly suffix: string;
}
export interface EnvVarConfig {
  readonly disabled: boolean;
  readonly variable: string;
  readonly default: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly style: SegmentStyle;
}
export interface CmdDurationConfig {
  readonly disabled: boolean;
  readonly minTimeMs: number;
  readonly prefix: string;
  readonly suffix: string;
  readonly style: SegmentStyle;
}
export interface JobsConfig {
  readonly disabled: boolean;
  readonly threshold: number;
  readonly symbol: string;
  readonly style: SegmentStyle;
  readonly suffix: string;
}
export interface StatusConfig {
  readonly disabled: boolean;
  readonly prefix: string;
  readonly suffix: string;
  readonly style: SegmentStyle;
}
export interface LineBreakConfig {
  readonly disabled: boolean;
}
export interface CharacterConfig {
  readonly disabled: boolean;
  readonly successSymbol: string;
  readonly errorSymbol: string;
  readonly successStyle: SegmentStyle;
  readonly errorStyle: SegmentStyle;
}

export interface SegmentConfigs {
  readonly directory: DirectoryConfig;
  readonly git_branch: GitBranchConfig;
  readonly git_commit: GitCommitConfig;
  readonly git_state: GitStateConfig;
  readonly git_status: GitStatusConfig;
  readonly package: PackageConfig;
  readonly bun: BunConfig;
  readonly nodejs: NodejsConfig;
  readonly python: PythonConfig;
  readonly env_var: EnvVarConfig;
  readonly cmd_duration: CmdDurationConfig;
  readonly jobs: JobsConfig;
  readonly status: StatusConfig;
  readonly line_break: LineBreakConfig;
  readonly character: CharacterConfig;
}

export interface PromptConfig {
  readonly layout?: readonly LayoutItem[];
  readonly newline?: boolean;
  readonly paintMs?: number;
  readonly backgroundMs?: number;
  readonly palette?: Readonly<Record<string, Color>>;
  readonly segments?: { readonly [K in SegmentName]?: Partial<SegmentConfigs[K]> };
}

export interface ResolvedPromptConfig {
  readonly layout: readonly LayoutItem[];
  readonly newline: boolean;
  readonly paintMs: number;
  readonly backgroundMs: number;
  readonly palette: Readonly<Record<string, Color>>;
  readonly segments: SegmentConfigs;
}

export interface CreatePromptOptions {
  readonly filesystem: PromptFilesystem;
  readonly versions?: VersionMap;
  readonly config?: PromptConfig;
  readonly file?: boolean;
  readonly logger?: (message: string, error?: unknown) => void;
}

export interface PromptMetrics {
  readonly paintMs: number;
  readonly backgroundMs: number | undefined;
  readonly sourceReads: number;
}
