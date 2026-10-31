import type { TurnFilesystem } from "../fs";
import { resolvePromptConfig } from "./defaults";
import type { Color, PromptConfig, ResolvedPromptConfig, SegmentName } from "../types";

const decoder = new TextDecoder();
const segmentNames: readonly SegmentName[] = [
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
  "jobs",
  "status",
  "line_break",
  "character",
];
const styleKeys = ["fg", "bg", "bold", "dim", "italic", "underline", "inverse", "strike"] as const;
const globalKeys = ["layout", "newline", "paintMs", "backgroundMs", "palette", "segments"] as const;

export interface ConfigDiagnostic {
  readonly path: string;
  readonly message: string;
}

export function parsePromptConfig(value: unknown): {
  config?: PromptConfig;
  errors: readonly ConfigDiagnostic[];
} {
  const errors: ConfigDiagnostic[] = [];
  if (!isRecord(value)) return { errors: [{ path: "$", message: "expected an object" }] };
  validateObjectKeys(value, globalKeys, "$", errors);
  validateNumber(value.paintMs, "paintMs", errors);
  validateNumber(value.backgroundMs, "backgroundMs", errors);
  if (value.newline !== undefined && typeof value.newline !== "boolean")
    errors.push({ path: "newline", message: "expected a boolean" });
  if (value.layout !== undefined) validateLayout(value.layout, errors);
  if (value.palette !== undefined) validatePalette(value.palette, errors);
  if (value.segments !== undefined) validateSegments(value.segments, errors);
  return errors.length ? { errors } : { config: value as PromptConfig, errors };
}

function validateNumber(value: unknown, path: string, errors: ConfigDiagnostic[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value)))
    errors.push({ path, message: "expected a finite number" });
}
function validateLayout(value: unknown, errors: ConfigDiagnostic[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "layout", message: "expected an array" });
    return;
  }
  value.forEach((item, index) => {
    const path = `layout[${index}]`;
    if (typeof item === "string") {
      if (!segmentNames.includes(item as SegmentName))
        errors.push({ path, message: `unknown segment ${item}` });
      return;
    }
    if (!isRecord(item)) {
      errors.push({ path, message: "expected a segment name or text object" });
      return;
    }
    validateObjectKeys(item, ["text", "style"], path, errors);
    if (typeof item.text !== "string")
      errors.push({ path: `${path}.text`, message: "expected a string" });
    if (item.style !== undefined) validateStyle(item.style, `${path}.style`, errors);
  });
}
function validatePalette(value: unknown, errors: ConfigDiagnostic[]): void {
  if (!isRecord(value)) {
    errors.push({ path: "palette", message: "expected an object" });
    return;
  }
  for (const [name, color] of Object.entries(value))
    if (!isColor(color)) errors.push({ path: `palette.${name}`, message: "expected a color" });
}
function validateSegments(value: unknown, errors: ConfigDiagnostic[]): void {
  if (!isRecord(value)) {
    errors.push({ path: "segments", message: "expected an object" });
    return;
  }
  for (const [name, config] of Object.entries(value)) {
    if (!segmentNames.includes(name as SegmentName)) {
      errors.push({ path: `segments.${name}`, message: "unknown segment" });
      continue;
    }
    if (!isRecord(config)) {
      errors.push({ path: `segments.${name}`, message: "expected an object" });
      continue;
    }
    for (const [key, field] of Object.entries(config)) {
      if (key.toLowerCase().includes("style"))
        validateStyle(field, `segments.${name}.${key}`, errors);
      else if (typeof field === "object" && field !== null && !Array.isArray(field))
        validateStyle(field, `segments.${name}.${key}`, errors);
      else if (!isPrimitive(field))
        errors.push({ path: `segments.${name}.${key}`, message: "expected a scalar or array" });
    }
  }
}
function validateStyle(value: unknown, path: string, errors: ConfigDiagnostic[]): void {
  if (!isRecord(value)) {
    errors.push({ path, message: "expected a style object" });
    return;
  }
  validateObjectKeys(value, styleKeys, path, errors);
  for (const key of ["fg", "bg"] as const)
    if (value[key] !== undefined && !isColor(value[key]))
      errors.push({ path: `${path}.${key}`, message: "expected a color" });
  for (const key of ["bold", "dim", "italic", "underline", "inverse", "strike"] as const)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      errors.push({ path: `${path}.${key}`, message: "expected a boolean" });
}
function validateObjectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ConfigDiagnostic[],
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      errors.push({ path: path === "$" ? key : `${path}.${key}`, message: "unknown field" });
}
function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isPrimitive))
  );
}
function isColor(value: unknown): value is Color {
  return (typeof value === "number" && Number.isInteger(value)) || typeof value === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface ConfigState {
  readonly identity: string;
  readonly config: ResolvedPromptConfig;
}

export class PromptConfigFile {
  private state: ConfigState | undefined;
  private readonly reported = new Set<string>();

  constructor(private readonly logger?: (message: string, error?: unknown) => void) {}

  async read(
    filesystem: TurnFilesystem,
    path: string,
    base: PromptConfig,
  ): Promise<ResolvedPromptConfig> {
    const entry = await filesystem.lookup(path);
    if (!entry || entry.kind !== "file") {
      this.state = { identity: "missing", config: resolvePromptConfig(base) };
      return this.state.config;
    }
    const identity = `${entry.ino}:${entry.mtime}`;
    if (this.state?.identity === identity) return this.state.config;
    const bytes = await filesystem.readFile(path);
    if (!bytes) return this.state?.config ?? resolvePromptConfig(base);
    const parsed = parsePromptConfig(parseJson(bytes));
    if (parsed.errors.length) {
      for (const error of parsed.errors) this.report(`${error.path}: ${error.message}`);
      return this.state?.config ?? resolvePromptConfig(base);
    }
    const config = resolvePromptConfig(mergePromptConfig(base, parsed.config));
    this.state = { identity, config };
    return config;
  }

  private report(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.logger?.(message);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}
function mergePromptConfig(base: PromptConfig, patch: PromptConfig | undefined): PromptConfig {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    palette: { ...base.palette, ...patch.palette },
    segments: { ...base.segments, ...patch.segments },
  };
}
