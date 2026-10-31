import { styleKey, styleToSgr, type StyleEnvironment } from "./style";
import type {
  LayoutItem,
  PromptContext,
  ResolvedPromptConfig,
  SegmentName,
  SegmentStyle,
} from "./types";
import type { DirectorySnapshot, ManifestSnapshot, SegmentInput } from "./segments/types";
import { renderBun } from "./segments/bun";
import { renderCharacter } from "./segments/character";
import { renderCmdDuration } from "./segments/cmd_duration";
import { renderDirectory } from "./segments/directory";
import { renderEnvVar } from "./segments/env_var";
import { renderJobs } from "./segments/jobs";
import { renderLineBreak } from "./segments/line_break";
import { renderNodejs } from "./segments/nodejs";
import { renderPackage } from "./segments/package";
import { renderPython } from "./segments/python";
import { renderStatus } from "./segments/status";

export interface Piece {
  readonly text: string;
  readonly style?: SegmentStyle;
}

export interface ComposeInput {
  readonly context: PromptContext;
  readonly config: ResolvedPromptConfig;
  readonly directory: DirectorySnapshot | undefined;
  readonly manifest: ManifestSnapshot | undefined;
  readonly versions: Readonly<{ bun?: string; node?: string; python?: string }>;
  readonly environment: StyleEnvironment;
}

const renderers: Partial<
  Record<SegmentName, (input: SegmentInput, config: never) => Piece[] | undefined>
> = {
  directory: (input, config) => renderDirectory(input, config),
  package: (input, config) => renderPackage(input, config),
  bun: (input, config) => renderBun(input, config),
  nodejs: (input, config) => renderNodejs(input, config),
  python: (input, config) => renderPython(input, config),
  env_var: (input, config) => renderEnvVar(input, config),
  cmd_duration: (input, config) => renderCmdDuration(input, config),
  jobs: (input, config) => renderJobs(input, config),
  status: (input, config) => renderStatus(input, config),
  line_break: (input, config) => renderLineBreak(input, config),
  character: (input, config) => renderCharacter(input, config),
};

function renderItem(item: LayoutItem, input: SegmentInput, config: ResolvedPromptConfig): Piece[] {
  if (typeof item !== "string") return item.text ? [{ text: item.text, style: item.style }] : [];
  const renderer = renderers[item];
  if (!renderer) return [];
  return renderer(input, config.segments[item] as never) ?? [];
}

export function composePrompt(input: ComposeInput): string {
  const segmentInput: SegmentInput = {
    context: input.context,
    directory: input.directory,
    manifest: input.manifest,
    versions: input.versions,
  };
  const pieces = input.config.layout.flatMap((item) =>
    renderItem(item, segmentInput, input.config),
  );
  const merged: Piece[] = [];
  for (const piece of pieces) {
    if (!piece.text) continue;
    const previous = merged.at(-1);
    if (previous && styleKey(previous.style) === styleKey(piece.style)) {
      merged[merged.length - 1] = { text: previous.text + piece.text, style: previous.style };
      continue;
    }
    merged.push(piece);
  }
  const body = merged
    .map(
      (piece) =>
        `${styleToSgr(piece.style, input.config.palette, input.environment)}${piece.text}${piece.style ? "\u001b[0m" : ""}`,
    )
    .join("");
  return `${input.config.newline ? "\n" : ""}${body}`;
}
