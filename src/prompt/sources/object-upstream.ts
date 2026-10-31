import type { TurnFilesystem } from "../fs";
import { readRef } from "./repo-refs";
import type { RepositorySnapshot } from "./repo-types";
import { requireObject } from "./object-work";

type Config = Map<string, Map<string, string[]>>;

export async function readUpstream(
  filesystem: TurnFilesystem,
  repository: RepositorySnapshot,
): Promise<string | undefined> {
  if (repository.head.kind !== "attached") return undefined;
  requireObject(repository.config !== undefined, "Git config unavailable");
  const config = parseConfig(repository.config);
  const branch = config.get(`branch\0${repository.head.branch}`);
  const merge = single(branch?.get("merge"));
  if (merge === undefined) return undefined;
  const remote = single(branch?.get("remote")) ?? "origin";
  const ref =
    remote === "."
      ? merge
      : trackingRef(config.get(`remote\0${remote}`)?.get("fetch") ?? [], merge);
  const commit = await readRef(filesystem, repository.commonDir, ref);
  requireObject(commit, "Git upstream ref unavailable");
  return commit;
}

function single(values: readonly string[] | undefined): string | undefined {
  requireObject(!values || values.length === 1, "Ambiguous Git upstream config");
  return values?.[0];
}

function trackingRef(specs: readonly string[], merge: string): string {
  let result: string | undefined;
  for (const value of specs) {
    requireObject(!value.startsWith("^"), "Negative Git fetch refspec unsupported");
    const spec = value.replace(/^\+/, "");
    const [source, target, extra] = spec.split(":");
    requireObject(target && extra === undefined, "Invalid Git fetch refspec");
    const position = source.indexOf("*");
    const mapped =
      position < 0 ? (source === merge ? target : undefined) : wildcardRef(source, target, merge);
    if (!mapped) continue;
    requireObject(!result || result === mapped, "Ambiguous Git fetch refspec");
    result = mapped;
  }
  requireObject(result, "Missing Git fetch refspec");
  return result;
}

function wildcardRef(source: string, target: string, merge: string): string | undefined {
  const [prefix, suffix, extra] = source.split("*");
  requireObject(suffix !== undefined && extra === undefined && target.split("*").length === 2);
  if (
    !merge.startsWith(prefix) ||
    !merge.endsWith(suffix) ||
    merge.length < prefix.length + suffix.length
  )
    return undefined;
  return target.replace("*", merge.slice(prefix.length, suffix ? -suffix.length : undefined));
}

function parseConfig(text: string): Config {
  requireObject(text.length <= 256 * 1024, "Git config exceeds 256 KiB");
  const result: Config = new Map();
  let section: Map<string, string[]> | undefined;
  for (const raw of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const parsed = /^\[([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]\s*(?:[#;].*)?$/.exec(line);
      requireObject(parsed, "Unsupported Git config section");
      const name = parsed[1].toLowerCase();
      requireObject(
        !name.startsWith("branch.") && !name.startsWith("remote."),
        "Deprecated Git config subsections unsupported",
      );
      requireObject(name !== "include" && name !== "includeif", "Git config includes unsupported");
      const key = `${name}\0${parsed[2] === undefined ? "" : unquote(`"${parsed[2]}"`)}`;
      section = result.get(key) ?? new Map();
      result.set(key, section);
      continue;
    }
    const parsed = /^([a-z][\w-]*)\s*(?:=\s*(.*))?$/i.exec(line);
    requireObject(parsed && section, "Invalid Git config entry");
    const key = parsed[1].toLowerCase();
    const values = section.get(key) ?? [];
    values.push(unquote(parsed[2] ?? "true"));
    section.set(key, values);
  }
  requireObject(
    !result.get("extensions\0")?.get("worktreeconfig"),
    "Git worktree config unsupported",
  );
  return result;
}

function unquote(text: string): string {
  let quoted = false;
  let value = "";
  for (let position = 0; position < text.length; position++) {
    const char = text[position];
    if (!quoted && (char === "#" || char === ";")) break;
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = text[++position];
    const replacement =
      escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "b" ? "\b" : escaped;
    requireObject(
      escaped === "n" || escaped === "t" || escaped === "b" || escaped === '"' || escaped === "\\",
    );
    value += replacement;
  }
  requireObject(!quoted, "Unclosed Git config quote");
  return value.trim();
}
