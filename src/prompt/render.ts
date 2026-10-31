import { composePrompt } from "./compose";
import { resolvePromptConfig } from "./config/defaults";
import { TurnFilesystem } from "./fs";
import { PromptTurnLive } from "./live";
import { readDirectory, readManifest } from "./sources";
import type {
  CreatePromptOptions,
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
    base: import("./types").PromptConfig,
  ): Promise<ResolvedPromptConfig>;
}

export interface RenderResult {
  readonly text: string;
  readonly metrics: PromptMetrics;
}

interface RenderState {
  readonly config: ResolvedPromptConfig;
  readonly directory: DirectorySnapshot | undefined;
  readonly manifest: ManifestSnapshot | undefined;
}

function environment(context: PromptContext): { noColor: boolean; trueColor: boolean } {
  const term = context.variables.get("TERM") ?? "";
  const color = context.variables.get("COLORTERM") ?? "";
  return {
    noColor: context.variables.has("NO_COLOR"),
    trueColor: color === "truecolor" || color === "24bit" || term.includes("direct"),
  };
}

function configPath(context: PromptContext): string {
  const home = context.variables.get("HOME") ?? "/";
  return `${home.replace(/\/$/, "")}/.config/bash-web/prompt.json`;
}

export async function renderPrompt(
  options: CreatePromptOptions,
  versions: VersionMap,
  context: PromptContext,
  live: PromptLive,
  configFile: PromptConfigReader | Promise<PromptConfigReader> | undefined,
  baseConfig: ResolvedPromptConfig = resolvePromptConfig(options.config),
): Promise<RenderResult> {
  const started = performance.now();
  const filesystem = new TurnFilesystem(options.filesystem);
  const configPromise =
    options.file && configFile
      ? Promise.resolve(configFile).then((reader) =>
          reader.read(filesystem, configPath(context), options.config ?? {}),
        )
      : Promise.resolve(baseConfig);
  const directoryPromise = readDirectory(filesystem, context.cwd);
  const manifestPromise = directoryPromise.then((directory) =>
    readManifest(filesystem, context.cwd, directory),
  );
  const fast = Promise.all([configPromise, directoryPromise, manifestPromise]);
  const timed = await Promise.race([fast.then(() => true), timeout(baseConfig.paintMs)]);
  let state: RenderState = { config: baseConfig, directory: undefined, manifest: undefined };
  if (timed) state = await readState(configPromise, directoryPromise, manifestPromise, baseConfig);
  const render = (next: RenderState) =>
    composePrompt({
      context,
      config: next.config,
      directory: next.directory,
      manifest: next.manifest,
      versions,
      environment: environment(context),
    });
  const text = render(state);
  void fast
    .then(async ([config, directory, manifest]) => {
      if (live.signal.aborted) return;
      const next = render({ config, directory, manifest });
      if (next !== text) live.update(next);
    })
    .catch((error: unknown) => options.logger?.("prompt source failed", error));
  return {
    text,
    metrics: {
      paintMs: performance.now() - started,
      backgroundMs: timed ? undefined : undefined,
      sourceReads: filesystem.requestCount,
    },
  };
}

async function readState(
  config: Promise<ResolvedPromptConfig>,
  directory: Promise<DirectorySnapshot | undefined>,
  manifest: Promise<ManifestSnapshot | undefined>,
  fallback: ResolvedPromptConfig,
): Promise<RenderState> {
  const [resolvedConfig, resolvedDirectory, resolvedManifest] = await Promise.all([
    config,
    directory,
    manifest,
  ]);
  return {
    config: resolvedConfig ?? fallback,
    directory: resolvedDirectory,
    manifest: resolvedManifest,
  };
}
function timeout(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}

export function createTurnLive(
  signal: AbortSignal,
  generation: number,
  currentGeneration: () => number,
  update: (text: string) => void,
): PromptLive {
  return new PromptTurnLive(signal, generation, currentGeneration, update);
}
