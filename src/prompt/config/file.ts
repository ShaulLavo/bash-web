import type { PromptEntry, TurnFilesystem } from "../fs";
import { defaultPromptConfig, resolvePromptConfig } from "./defaults";
import type { Color, PromptConfig, ResolvedPromptConfig, SegmentName } from "../types";

const decoder = new TextDecoder();
const segmentNames = Object.keys(defaultPromptConfig.segments);
const styleKeys = ["fg", "bg", "bold", "dim", "italic", "underline", "inverse", "strike"] as const;
const globalKeys = ["layout", "newline", "paintMs", "backgroundMs", "palette", "segments"] as const;
const segmentSchemas = {
  ...defaultPromptConfig.segments,
  git_branch: { ...defaultPromptConfig.segments.git_branch, truncateLength: 0 },
};

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
  if (value.paintMs !== undefined) validateNumber(value.paintMs, "paintMs", errors, false);
  if (value.backgroundMs !== undefined)
    validateNumber(value.backgroundMs, "backgroundMs", errors, false);
  if (value.newline !== undefined && typeof value.newline !== "boolean")
    errors.push({ path: "newline", message: "expected a boolean" });
  if (value.layout !== undefined) validateLayout(value.layout, errors);
  if (value.palette !== undefined) validatePalette(value.palette, errors);
  if (value.segments !== undefined) validateSegments(value.segments, errors);
  return errors.length ? { errors } : { config: value as PromptConfig, errors };
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
    if (!isColor(color))
      errors.push({
        path: `palette.${name}`,
        message: "expected a named color, ANSI index, or hex color",
      });
}

function validateSegments(value: unknown, errors: ConfigDiagnostic[]): void {
  if (!isRecord(value)) {
    errors.push({ path: "segments", message: "expected an object" });
    return;
  }
  for (const [name, config] of Object.entries(value)) {
    const segment = name as SegmentName;
    const path = `segments.${name}`;
    if (!segmentNames.includes(segment)) {
      errors.push({ path, message: "unknown segment" });
      continue;
    }
    if (!isRecord(config)) {
      errors.push({ path, message: "expected an object" });
      continue;
    }
    const schema = segmentSchemas[segment];
    validateSegment(config, schema, path, errors);
  }
}

function validateSegment(
  config: Record<string, unknown>,
  schema: object,
  path: string,
  errors: ConfigDiagnostic[],
): void {
  for (const [key, field] of Object.entries(config)) {
    const location = `${path}.${key}`;
    if (!Object.hasOwn(schema, key)) {
      errors.push({ path: location, message: "unknown field" });
      continue;
    }
    const sample: unknown = Reflect.get(schema, key);
    validateField(field, sample, location, errors);
  }
}

function validateField(
  value: unknown,
  sample: unknown,
  path: string,
  errors: ConfigDiagnostic[],
): void {
  if (Array.isArray(sample)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      errors.push({ path, message: "expected an array of strings" });
    return;
  }
  if (typeof sample === "object") {
    validateStyle(value, path, errors);
    return;
  }
  if (typeof sample === "number") {
    validateNumber(value, path, errors, true);
    return;
  }
  if (typeof value !== typeof sample) errors.push({ path, message: `expected a ${typeof sample}` });
}

function validateNumber(
  value: unknown,
  path: string,
  errors: ConfigDiagnostic[],
  integer: boolean,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    (integer && value < 0)
  )
    errors.push({
      path,
      message: integer ? "expected a nonnegative integer" : "expected a finite number",
    });
}

function validateStyle(value: unknown, path: string, errors: ConfigDiagnostic[]): void {
  if (!isRecord(value)) {
    errors.push({ path, message: "expected a style object" });
    return;
  }
  validateObjectKeys(value, styleKeys, path, errors);
  for (const key of ["fg", "bg"] as const)
    if (value[key] !== undefined && !isColor(value[key]))
      errors.push({
        path: `${path}.${key}`,
        message: "expected a named color, ANSI index, or hex color",
      });
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

function isColor(value: unknown): value is Color {
  return (
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) ||
    (typeof value === "string" && /^[a-z][a-z0-9_-]*$/i.test(value)) ||
    (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))
  );
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
    knownEntry?: PromptEntry,
  ): Promise<ResolvedPromptConfig> {
    const entry = knownEntry ?? (await filesystem.lookup(path));
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
    const config = resolvePromptConfig(base, parsed.config);
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
