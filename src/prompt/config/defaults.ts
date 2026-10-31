import type { PromptConfig, ResolvedPromptConfig, SegmentConfigs } from "../types";

const plain = Object.freeze({});
const defaultSegments: SegmentConfigs = {
  directory: {
    disabled: false,
    style: { fg: "cyan", bold: true },
    truncationLength: 3,
    truncationSymbol: "…/",
    homeSymbol: "~",
    suffix: " ",
    repoRootStyle: plain,
  },
  git_branch: {
    disabled: false,
    prefix: "on ",
    symbol: " ",
    style: { fg: "purple", bold: true },
    suffix: " ",
    truncationSymbol: "…",
    onlyAttached: false,
    ignoreBranches: [],
  },
  git_commit: {
    disabled: false,
    prefix: "",
    suffix: " ",
    style: { fg: "green", bold: true },
    length: 7,
  },
  git_state: {
    disabled: false,
    prefix: "(",
    suffix: ") ",
    style: { fg: "yellow", bold: true },
  },
  git_status: {
    counts: false,
    conflicted: "=",
    stashed: "$",
    deleted: "✘",
    modified: "!",
    typeChanged: "",
    untracked: "?",
    staged: "+",
    ahead: "⇡",
    behind: "⇣",
    diverged: "⇕",
    unknown: "…",
    disabled: false,
    prefix: "",
    suffix: " ",
    style: { fg: "red", bold: true },
  },
  package: {
    disabled: false,
    prefix: "is ",
    symbol: "📦 ",
    style: { fg: 208, bold: true },
    suffix: " ",
    showPrivate: false,
  },
  bun: {
    disabled: false,
    prefix: "via ",
    symbol: "🥟 ",
    style: { fg: "red", bold: true },
    suffix: " ",
  },
  nodejs: {
    disabled: false,
    prefix: "via ",
    symbol: " ",
    style: { fg: "green", bold: true },
    suffix: " ",
  },
  python: {
    disabled: false,
    prefix: "via ",
    symbol: "🐍 ",
    style: { fg: "green", bold: true },
    suffix: " ",
  },
  env_var: {
    disabled: false,
    variable: "",
    default: "",
    prefix: " ",
    suffix: "",
    style: plain,
  },
  cmd_duration: {
    disabled: false,
    minTimeMs: 2_000,
    prefix: "took ",
    suffix: " ",
    style: { fg: "yellow", bold: true },
  },
  jobs: {
    disabled: false,
    threshold: 1,
    symbol: "✦",
    style: { fg: "blue", bold: true },
    suffix: " ",
  },
  status: {
    disabled: true,
    prefix: " ",
    suffix: " ",
    style: { fg: "red", bold: true },
  },
  line_break: { disabled: false },
  character: {
    disabled: false,
    successSymbol: "❯",
    errorSymbol: "❯",
    successStyle: { fg: "green", bold: true },
    errorStyle: { fg: "red", bold: true },
  },
};

export const defaultPromptConfig: ResolvedPromptConfig = {
  layout: [
    "directory",
    "git_branch",
    "git_commit",
    "git_state",
    "git_status",
    "package",
    "bun",
    "nodejs",
    "python",
    "env_var",
    "cmd_duration",
    "line_break",
    "jobs",
    "status",
    "character",
  ],
  newline: true,
  paintMs: 15,
  backgroundMs: 2_000,
  palette: {},
  segments: defaultSegments,
};

function mergeObject<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  const result = { ...base };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    const previous = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === "object"
    ) {
      result[key] = mergeObject(previous, value as Partial<typeof previous>);
    } else if (value !== undefined) {
      result[key] = value as T[keyof T];
    }
  }
  return result;
}

export function resolvePromptConfig(
  config: PromptConfig | undefined,
  override?: PromptConfig,
): ResolvedPromptConfig {
  const host = mergeObject(defaultPromptConfig, config as Partial<ResolvedPromptConfig>);
  const merged = mergeObject(host, override as Partial<ResolvedPromptConfig>);
  return {
    ...merged,
    layout: Array.from(merged.layout),
    paintMs: Math.min(50, Math.max(0, merged.paintMs)),
    backgroundMs: Math.max(0, merged.backgroundMs),
  };
}
