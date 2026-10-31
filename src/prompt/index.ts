import { defaultPromptConfig, resolvePromptConfig } from "./config/defaults";
import { createTurnLive, renderPrompt, type PromptConfigReader } from "./render";
import type {
  CreatePromptOptions,
  PromptContext,
  PromptLive,
  PromptProvider,
  PromptStart,
  VersionMap,
} from "./types";

export function createPrompt(options: CreatePromptOptions): PromptProvider {
  const versions: VersionMap = options.versions ?? {};
  const baseConfig = resolvePromptConfig(options.config);
  let configFilePromise: Promise<PromptConfigReader> | undefined;
  const configFile = () => {
    configFilePromise ??= import("./config/file").then(
      ({ PromptConfigFile }) => new PromptConfigFile(options.logger),
    );
    return configFilePromise;
  };
  let generation = 0;
  let start: PromptStart | undefined;
  const controllers = new Set<AbortController>();
  const variables = new Set(["HOME", "VIRTUAL_ENV", "COLORTERM", "TERM", "NO_COLOR"]);
  for (const item of baseConfig.layout)
    if (item === "env_var") {
      const variable = baseConfig.segments.env_var.variable;
      if (variable) variables.add(variable);
    }
  return {
    variables: Array.from(variables),
    prepare(nextStart: PromptStart) {
      start = nextStart;
    },
    render(context: PromptContext, live: PromptLive): Promise<string> {
      generation++;
      for (const controller of controllers) controller.abort();
      const local = new AbortController();
      controllers.add(local);
      const combined = combineSignals(context.signal, live.signal, local.signal);
      const turnLive = createTurnLive(
        combined,
        generation,
        () => generation,
        live.update.bind(live),
      );
      const variables = new Map(start ? Object.entries(start.env) : []);
      for (const [name, value] of context.variables) variables.set(name, value);
      return renderPrompt(
        { ...options, config: options.config ?? defaultPromptConfig },
        versions,
        { ...context, variables, signal: combined },
        turnLive,
        options.file ? configFile() : undefined,
        baseConfig,
      )
        .then((result) => result.text)
        .catch((error: unknown) => {
          options.logger?.("prompt render failed", error);
          return context.ps1;
        })
        .finally(() => controllers.delete(local));
    },
  };
}

function combineSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) return AbortSignal.abort();
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export { defaultPromptConfig, resolvePromptConfig } from "./config/defaults";
export { composePrompt } from "./compose";
export { renderPrompt } from "./render";
export { runWorkUnits, PromptTurnLive } from "./live";
export type { WorkOptions, WorkUnit } from "./live";
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
  PromptStart,
  PythonConfig,
  ResolvedPromptConfig,
  SegmentConfigs,
  SegmentName,
  SegmentStyle as Style,
  StatusConfig,
  VersionMap,
} from "./types";
