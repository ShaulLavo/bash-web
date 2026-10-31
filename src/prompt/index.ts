import { resolvePromptConfig } from "./config/defaults";
import { renderPrompt, type PromptConfigReader } from "./render";
import type {
  CreatePromptOptions,
  PromptContext,
  PromptLive,
  PromptProvider,
  VersionMap,
  ResolvedPromptConfig,
} from "./types";

export function createPrompt(options: CreatePromptOptions): PromptProvider {
  const versions: VersionMap = options.versions ?? {};
  const baseConfig = resolvePromptConfig(options.config);
  const variableNames = configuredVariables(baseConfig);
  const generations = new WeakMap<AbortSignal, number>();
  const readers = new Map<string, Promise<PromptConfigReader>>();
  const loadConfigFile = (path: string) => {
    let reader = readers.get(path);
    if (!reader) {
      reader = import("./config/file").then(
        ({ PromptConfigFile }) => new PromptConfigFile(options.logger),
      );
      readers.set(path, reader);
    }
    return reader;
  };
  return {
    get variables() {
      return Array.from(variableNames);
    },
    prepare() {},
    render(context: PromptContext, live: PromptLive): Promise<string> {
      const combined = live.signal;
      generations.set(combined, context.turn);
      const turnLive: PromptLive = {
        signal: combined,
        update(text) {
          if (generations.get(combined) === context.turn && !combined.aborted) live.update(text);
        },
      };
      return renderPrompt(
        options,
        versions,
        context,
        turnLive,
        loadConfigFile,
        baseConfig,
        (config) => {
          for (const variable of configuredVariables(config)) variableNames.add(variable);
        },
      )
        .then((result) => result.text)
        .catch((error: unknown) => {
          options.logger?.("prompt render failed", error);
          return context.ps1;
        });
    },
  };
}

function configuredVariables(config: ResolvedPromptConfig): Set<string> {
  const variables = new Set([
    "HOME",
    "VIRTUAL_ENV",
    "COLORTERM",
    "TERM",
    "NO_COLOR",
    "GIT_DIR",
    "GIT_WORK_TREE",
  ]);
  const envVar = config.segments.env_var.variable;
  if (envVar) variables.add(envVar);
  return variables;
}

export { defaultPromptConfig, resolvePromptConfig } from "./config/defaults";
export { composePrompt } from "./compose";
export { renderPrompt } from "./render";
export { WorkBudget, PromptTurnLive } from "./live";
export type {
  BunConfig,
  CharacterConfig,
  CmdDurationConfig,
  Color,
  CreatePromptOptions,
  DirectoryConfig,
  EnvVarConfig,
  GitBranchConfig,
  GitCommitConfig,
  GitStateConfig,
  GitStatusConfig,
  JobsConfig,
  LayoutItem,
  LineBreakConfig,
  NodejsConfig,
  PackageConfig,
  PromptConfig,
  PromptContext,
  PromptFilesystem,
  PromptLive,
  PromptMetrics,
  PromptProvider,
  PythonConfig,
  PromptStart,
  ResolvedPromptConfig,
  SegmentConfigs,
  SegmentName,
  SegmentStyle as Style,
  StatusConfig,
  VersionMap,
} from "./types";
