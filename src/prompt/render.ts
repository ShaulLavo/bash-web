import type { RepositorySnapshot } from "./sources/repo-types";
import { composePrompt } from "./compose";
import { resolvePromptConfig } from "./config/defaults";
import { TurnFilesystem, type PromptEntry } from "./fs";
import { WorkBudget, PromptTurnLive } from "./live";
import { readDirectory, readManifest, readRepository } from "./sources";
import type {
  CreatePromptOptions,
  PromptConfig,
  PromptContext,
  PromptLive,
  PromptMetrics,
  ResolvedPromptConfig,
  VersionMap,
} from "./types";
import type { DirectorySnapshot, ManifestSnapshot } from "./segments/types";

export interface PromptConfigReader {
  read(
    filesystem: TurnFilesystem,
    path: string,
    base: PromptConfig,
    knownEntry?: PromptEntry,
  ): Promise<ResolvedPromptConfig>;
}
export type PromptConfigLoader = (path: string) => Promise<PromptConfigReader>;
export interface RenderResult {
  readonly text: string;
  readonly metrics: PromptMetrics;
}
interface RenderState {
  config: ResolvedPromptConfig;
  directory: DirectorySnapshot | undefined;
  manifest: ManifestSnapshot | undefined;
  repository: RepositorySnapshot | undefined;
}

export async function renderPrompt(
  options: CreatePromptOptions,
  versions: VersionMap,
  context: PromptContext,
  live: PromptLive,
  configFileLoader: PromptConfigLoader | undefined,
  baseConfig: ResolvedPromptConfig = resolvePromptConfig(options.config),
  onConfig?: (config: ResolvedPromptConfig) => void,
): Promise<RenderResult> {
  const started = performance.now();
  const budget = new WorkBudget(live.signal, baseConfig.backgroundMs);
  const filesystem = new TurnFilesystem(options.filesystem, budget);
  const state: RenderState = {
    config: baseConfig,
    directory: undefined,
    manifest: undefined,
    repository: undefined,
  };
  const work = populate(
    state,
    options,
    context,
    filesystem,
    budget,
    configFileLoader,
    onConfig,
  ).catch((error: unknown) => {
    options.logger?.("prompt source failed", error);
  });
  await waitForPaint(work, baseConfig.paintMs, live.signal);
  const text = renderState(context, versions, state);
  const updates = new PromptTurnLive(
    live.signal,
    context.turn,
    () => context.turn,
    (next) => {
      if (budget.active) live.update(next);
    },
  );
  void work.then(() => {
    if (!budget.active) return;
    const nextText = renderState(context, versions, state);
    if (nextText !== text) updates.update(nextText);
  });
  return {
    text,
    metrics: {
      paintMs: performance.now() - started,
      backgroundMs: undefined,
      sourceReads: filesystem.requestCount,
    },
  };
}

async function populate(
  state: RenderState,
  options: CreatePromptOptions,
  context: PromptContext,
  filesystem: TurnFilesystem,
  budget: WorkBudget,
  loader: PromptConfigLoader | undefined,
  onConfig: ((config: ResolvedPromptConfig) => void) | undefined,
): Promise<void> {
  if (options.file && loader) {
    const config = await readConfig(options, context, filesystem, budget, loader);
    if (!budget.active) return;
    if (config) state.config = config;
    budget.setDuration(state.config.backgroundMs);
    if (!budget.active) return;
    onConfig?.(state.config);
  }
  const enabled = state.config.layout.filter(
    (item) => typeof item === "string" && !state.config.segments[item].disabled,
  );
  const needsDirectory = enabled.some(
    (item) => item === "package" || item === "bun" || item === "nodejs",
  );
  const needsRepository = enabled.some(
    (item) =>
      item === "git_branch" ||
      item === "git_commit" ||
      item === "git_state" ||
      item === "git_status",
  );
  await Promise.all([
    needsDirectory ? populateDirectory(state, filesystem, context, budget, enabled) : undefined,
    needsRepository
      ? readRepository(filesystem, context).then((repository) => {
          if (budget.active) state.repository = repository;
        })
      : undefined,
  ]);
}

async function populateDirectory(
  state: RenderState,
  filesystem: TurnFilesystem,
  context: PromptContext,
  budget: WorkBudget,
  enabled: readonly unknown[],
): Promise<void> {
  const directory = await readDirectory(filesystem, context.cwd);
  if (!budget.active) return;
  state.directory = directory;
  if (!enabled.includes("package") && !enabled.includes("nodejs")) return;
  const manifest = await readManifest(filesystem, context.cwd, directory);
  if (budget.active) state.manifest = manifest;
}

async function readConfig(
  options: CreatePromptOptions,
  context: PromptContext,
  filesystem: TurnFilesystem,
  budget: WorkBudget,
  loader: PromptConfigLoader,
): Promise<ResolvedPromptConfig | undefined> {
  const home = context.variables.get("HOME") ?? "/";
  const path = `${home.replace(/\/$/, "")}/.config/bash-web/prompt.json`;
  const entry = await filesystem.lookup(path);
  if (!entry || entry.kind !== "file" || !budget.active) return undefined;
  const reader = await budget.run(() => loader(path));
  if (!reader || !budget.active) return undefined;
  return budget.run(() => reader.read(filesystem, path, options.config ?? {}, entry));
}

function renderState(context: PromptContext, versions: VersionMap, state: RenderState): string {
  const term = context.variables.get("TERM") ?? "";
  const color = context.variables.get("COLORTERM") ?? "";
  return composePrompt({
    context,
    config: state.config,
    directory: state.directory,
    manifest: state.manifest,
    repository: state.repository,
    versions,
    environment: {
      noColor: context.variables.has("NO_COLOR"),
      trueColor: color === "truecolor" || color === "24bit" || term.includes("direct"),
    },
  });
}

async function waitForPaint(work: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const wait = new Promise<void>((resolve) => {
    stop = resolve;
    timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) resolve();
  });
  try {
    await Promise.race([work, wait]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
