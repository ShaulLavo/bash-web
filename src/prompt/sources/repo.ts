import type { PromptEntry, TurnFilesystem } from "../fs";
import type { PromptContext } from "../types";
import type { GitOperation, RepositoryHead, RepositorySnapshot } from "./repo-types";
import { resolveRef, validRef } from "./repo-refs";

export { readRef } from "./repo-refs";
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxStashLogBytes = 64 * 1024;
type Candidate = { readonly root: string; readonly gitDir: string };
type Directory = Extract<PromptEntry, { kind: "dir" }>;

export async function readRepository(
  filesystem: TurnFilesystem,
  context: PromptContext,
): Promise<RepositorySnapshot | undefined> {
  const explicit = context.variables.get("GIT_DIR");
  const workTree = context.variables.get("GIT_WORK_TREE");
  const candidate =
    explicit !== undefined
      ? {
          root: resolvePath(context.cwd, workTree ?? "."),
          gitDir: resolvePath(context.cwd, explicit),
        }
      : await discover(filesystem, context.cwd);
  if (!candidate) return undefined;
  const selected =
    workTree === undefined ? candidate : { ...candidate, root: resolvePath(context.cwd, workTree) };
  try {
    return await readAt(filesystem, selected);
  } catch {
    return unknownRepository(selected);
  }
}

async function discover(filesystem: TurnFilesystem, cwd: string): Promise<Candidate | undefined> {
  const roots = ancestors(normalizePath(cwd));
  const entries = await Promise.all(roots.map((path) => filesystem.lookup(path)));
  for (let index = 0; index < roots.length; index++) {
    const entry = entries[index];
    if (entry?.kind !== "dir" || !entry.children.has(".git")) continue;
    return { root: roots[index], gitDir: joinPath(roots[index], ".git") };
  }
  return undefined;
}

async function readAt(
  filesystem: TurnFilesystem,
  candidate: Candidate,
): Promise<RepositorySnapshot> {
  const gitDir = await resolveGitDirectory(filesystem, candidate.gitDir);
  const entry = await filesystem.lookup(gitDir);
  if (entry?.kind !== "dir") return unknownRepository(candidate);
  const commonDir = entry.children.has("commondir")
    ? resolvePath(gitDir, await requiredText(filesystem, joinPath(gitDir, "commondir")))
    : gitDir;
  const config = await requiredText(filesystem, joinPath(commonDir, "config"));
  const common = commonDir === gitDir ? entry : await filesystem.lookup(commonDir);
  const unsupported =
    unsupportedFormat(config) || common?.kind !== "dir" || common.children.has("reftable");
  const [head, operation, stash] = await Promise.all([
    unsupported ? { kind: "unknown" as const } : readHead(filesystem, gitDir, commonDir),
    readOperation(filesystem, gitDir, entry),
    unsupported ? { present: undefined } : readStash(filesystem, commonDir),
  ]);
  return { root: candidate.root, gitDir, commonDir, head, operation, stash, config };
}

async function resolveGitDirectory(filesystem: TurnFilesystem, path: string): Promise<string> {
  const entry = await filesystem.lookup(path);
  if (entry?.kind === "dir") return path;
  if (entry?.kind !== "file") throw new Error("Missing git directory");
  const text = await requiredText(filesystem, path);
  const match = /^gitdir: (.+)$/u.exec(text);
  if (!match) throw new Error("Invalid gitdir file");
  return resolvePath(parentPath(path), match[1]);
}

async function readHead(
  filesystem: TurnFilesystem,
  gitDir: string,
  commonDir: string,
): Promise<RepositoryHead> {
  const text = await requiredText(filesystem, joinPath(gitDir, "HEAD"));
  if (/^[0-9a-f]{40}$/u.test(text)) return { kind: "detached", commit: text };
  if (!text.startsWith("ref: refs/heads/")) return { kind: "unknown" };
  const ref = text.slice(5);
  if (!validRef(ref)) return { kind: "unknown" };
  const value = await resolveRef(filesystem, commonDir, ref);
  if (value.kind === "unknown") return { kind: "unknown" };
  return {
    kind: "attached",
    branch: ref.slice(11),
    commit: value.kind === "resolved" ? value.commit : undefined,
  };
}

async function readOperation(
  filesystem: TurnFilesystem,
  gitDir: string,
  entry: Directory,
): Promise<GitOperation | undefined> {
  try {
    if (entry.children.has("rebase-merge"))
      return await readRebase(filesystem, gitDir, "rebase-merge");
    if (entry.children.has("rebase-apply"))
      return await readRebase(filesystem, gitDir, "rebase-apply");
    const markers = [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["BISECT_LOG", "bisect"],
    ] as const;
    for (const [name, kind] of markers) {
      if (entry.children.has(name)) return { kind };
    }
    return undefined;
  } catch {
    return { kind: "unknown" };
  }
}

async function readRebase(
  filesystem: TurnFilesystem,
  gitDir: string,
  name: "rebase-merge" | "rebase-apply",
): Promise<GitOperation> {
  const path = joinPath(gitDir, name);
  const entry = await filesystem.lookup(path);
  if (entry?.kind !== "dir") return { kind: "unknown" };
  const applying = name === "rebase-apply";
  const kind = applying && entry.children.has("applying") ? "am" : "rebase";
  const [current, total] = await Promise.all([
    readNumber(filesystem, path, entry, applying ? "next" : "msgnum"),
    readNumber(filesystem, path, entry, applying ? "last" : "end"),
  ]);
  const progress =
    current !== undefined && total !== undefined && current <= total
      ? { current, total }
      : undefined;
  return { kind, progress };
}

async function readNumber(
  filesystem: TurnFilesystem,
  path: string,
  entry: Directory,
  name: string,
): Promise<number | undefined> {
  if (!entry.children.has(name)) return undefined;
  const value = await requiredText(filesystem, joinPath(path, name));
  const number = /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

async function readStash(
  filesystem: TurnFilesystem,
  commonDir: string,
): Promise<RepositorySnapshot["stash"]> {
  try {
    const ref = await resolveRef(filesystem, commonDir, "refs/stash");
    if (ref.kind === "unknown") return { present: undefined };
    if (ref.kind === "missing") return { present: false };
    const path = joinPath(commonDir, "logs/refs/stash");
    const entry = await filesystem.lookup(path);
    if (entry?.kind !== "file") return { present: true };
    const bytes = await filesystem.readFile(path);
    if (!bytes?.length || bytes.length > maxStashLogBytes) return { present: true };
    let count = bytes[bytes.length - 1] === 10 ? 0 : 1;
    for (const byte of bytes) if (byte === 10) count++;
    return { present: true, count };
  } catch {
    return { present: undefined };
  }
}

function unsupportedFormat(config: string): boolean {
  let section = "";
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) section = line.toLowerCase();
    if (section !== "[extensions]") continue;
    const match = /^(objectformat|refstorage)\s*=\s*"?([^"\s#;]+)"?/iu.exec(line);
    if (!match) continue;
    const supported = match[1].toLowerCase() === "objectformat" ? "sha1" : "files";
    if (match[2].toLowerCase() !== supported) return true;
  }
  return false;
}

async function requiredText(filesystem: TurnFilesystem, path: string): Promise<string> {
  const bytes = await filesystem.readFile(path);
  if (!bytes) throw new Error("Missing git metadata");
  const text = decoder.decode(bytes).trim();
  if (!text || text.includes("\0")) throw new Error("Invalid git metadata");
  return text;
}

function unknownRepository(candidate: Candidate): RepositorySnapshot {
  return {
    ...candidate,
    commonDir: candidate.gitDir,
    head: { kind: "unknown" },
    operation: { kind: "unknown" },
    stash: { present: undefined },
    config: undefined,
  };
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  let current = path;
  while (true) {
    result.push(current);
    if (current === "/") return result;
    current = parentPath(current);
  }
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function joinPath(base: string, child: string): string {
  return normalizePath(`${base}/${child}`);
}

function resolvePath(base: string, path: string): string {
  return path.startsWith("/") ? normalizePath(path) : joinPath(base, path);
}

function normalizePath(path: string): string {
  const result: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      result.pop();
      continue;
    }
    result.push(part);
  }
  return `/${result.join("/")}`;
}
