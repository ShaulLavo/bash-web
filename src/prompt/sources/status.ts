import { hex } from "./git-bytes";
import type { PromptEntry } from "../fs";
import { parseIndex } from "./index-file";
import type { IndexEntry, ParsedIndex } from "./index-types";
import { ignored, parseIgnore, type IgnoreRule } from "./ignore";
import type {
  ObjectReader,
  StatusCounts,
  StatusRequest,
  StatusSnapshot,
  StatusSource,
} from "./status-types";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
type Metadata =
  | NonNullable<PromptEntry>
  | { readonly kind: "dir"; readonly ino: number; readonly mtime: number };
type Directory = Extract<PromptEntry, { kind: "dir" }>;
interface Tree {
  readonly files: Map<string, IndexEntry>;
  readonly directories: Map<string, Tree>;
}
interface Cache {
  stamp: string;
  index: ParsedIndex | undefined;
  readonly clean: Map<string, string>;
  readonly untracked: Map<string, { readonly stamp: string; readonly names: readonly string[] }>;
  readonly last: Map<string, StatusSnapshot>;
  readonly logged: Set<string>;
  timeouts: number;
  running: Promise<unknown> | undefined;
}
interface Run {
  readonly request: StatusRequest;
  readonly cache: Cache;
  readonly counts: { -readonly [K in keyof StatusCounts]: number };
  directories: number;
  hashed: number;
}

export class GitStatusSource implements StatusSource {
  readonly #repositories = new Map<string, Cache>();
  #current = "";
  readonly #logger: ((message: string, error?: unknown) => void) | undefined;
  readonly #objects: ObjectReader | undefined;
  constructor(logger?: (message: string, error?: unknown) => void, objects?: ObjectReader) {
    this.#logger = logger;
    this.#objects = objects;
  }

  leave(): void {
    for (const cache of this.#repositories.values()) cache.timeouts = 0;
  }

  async read(request: StatusRequest): Promise<StatusSnapshot> {
    const key = `${request.repository.root}\0${request.repository.gitDir}`;
    if (this.#current !== key) {
      this.leave();
      this.#current = key;
    }
    let cache = this.#repositories.get(key);
    if (!cache) {
      cache = {
        stamp: "",
        index: undefined,
        clean: new Map(),
        untracked: new Map(),
        last: new Map(),
        logged: new Set(),
        timeouts: 0,
        running: undefined,
      };
      this.#repositories.set(key, cache);
    }
    const previous = cache.last.get(cacheKey(request));
    if (previous) request.stale({ ...previous, stale: true });
    // Repositories serialize work, even when two shells borrow this provider.
    const prior = cache.running;
    const run = Promise.resolve(prior)
      .catch(() => {})
      .then(() => this.#run(request, cache));
    cache.running = run;
    try {
      return await run;
    } finally {
      if (cache.running === run) cache.running = undefined;
    }
  }

  async #run(request: StatusRequest, cache: Cache): Promise<StatusSnapshot> {
    try {
      request.budget.check();
      if (request.repository.head.kind === "unknown") throw new Error("unsupported repository");
      const index = await readIndex(request, cache);
      if (cache.timeouts >= 2) throw new Error("deadline backoff");
      const run: Run = {
        request,
        cache,
        counts: { conflicted: 0, deleted: 0, modified: 0, typeChanged: 0, untracked: 0 },
        directories: 0,
        hashed: 0,
      };
      const tree = await trackedTree(run, index);
      const rules = await baseRules(run);
      await walk(run, "", tree, rules);
      const objects = this.#objects
        ? await this.#objects(request.filesystem, request.repository, index, request.budget)
        : undefined;
      request.budget.check();
      const result: StatusSnapshot = {
        value: { worktree: { kind: "known", value: run.counts }, ...(objects ? { objects } : {}) },
        stale: false,
      };
      cache.timeouts = 0;
      cache.last.set(cacheKey(request), result);
      return result;
    } catch (error) {
      if (request.budget.signal.aborted) throw error;
      if (!request.budget.active) cache.timeouts++;
      const kind = error instanceof Error ? error.message : "read failed";
      if (!cache.logged.has(kind)) {
        cache.logged.add(kind);
        this.#logger?.(`prompt status: ${kind}`);
      }
      return { value: { worktree: { kind: "unknown" } }, stale: false };
    }
  }
}

function cacheKey(request: StatusRequest): string {
  return `${request.context.cwd}\0${JSON.stringify(request.config)}\0${request.context.variables.get("HOME") ?? ""}`;
}
function stamp(entry: Metadata): string {
  return `${entry.kind}:${entry.ino}:${entry.mtime}`;
}
function pathAt(run: Run, path: string): string {
  const root = run.request.repository.root.replace(/\/$/u, "");
  return path ? `${root}/${path}` : root || "/";
}
function add(run: Run, kind: keyof StatusCounts): void {
  if (run.request.config.counts || !run.counts[kind]) run.counts[kind]++;
}

async function readIndex(request: StatusRequest, cache: Cache): Promise<ParsedIndex> {
  const directory = await request.filesystem.lookup(request.repository.gitDir);
  request.budget.check();
  if (directory?.kind !== "dir") throw new Error("missing git directory");
  const entry = directory.children.get("index");
  const key = entry ? stamp(entry) : "absent";
  if (key === cache.stamp && cache.index) return cache.index;
  const bytes = entry
    ? await request.filesystem.readFile(`${request.repository.gitDir}/index`)
    : undefined;
  request.budget.check();
  if (entry && !bytes) throw new Error("unreadable index");
  const index = bytes ? await parseIndex(bytes, request.budget) : { entries: [] };
  cache.stamp = key;
  cache.index = index;
  cache.clean.clear();
  cache.untracked.clear();
  cache.timeouts = 0;
  return index;
}

async function trackedTree(run: Run, index: ParsedIndex): Promise<Tree> {
  const root: Tree = { files: new Map(), directories: new Map() };
  const conflicts = new Set<string>();
  for (const [indexNumber, entry] of index.entries.entries()) {
    if (indexNumber % 64 === 0) await run.request.budget.checkpoint();
    if (entry.stage) conflicts.add(entry.path);
    addTracked(root, entry);
  }
  run.counts.conflicted = run.request.config.counts ? conflicts.size : Number(conflicts.size > 0);
  return root;
}
function addTracked(tree: Tree, entry: IndexEntry): void {
  const parts = entry.path.split("/");
  const name = parts.pop() ?? "";
  for (const part of parts) {
    let child = tree.directories.get(part);
    if (!child) {
      child = { files: new Map(), directories: new Map() };
      tree.directories.set(part, child);
    }
    tree = child;
  }
  tree.files.set(name, entry);
}

async function baseRules(run: Run): Promise<IgnoreRule[]> {
  const home = run.request.context.variables.get("HOME") ?? "/";
  const paths = [
    `${home.replace(/\/$/u, "")}/.config/git/ignore`,
    `${run.request.repository.commonDir}/info/exclude`,
  ];
  let rules: IgnoreRule[] = [];
  for (const path of paths) rules = rules.concat(await readRules(run, path, ""));
  return rules;
}
async function readRules(run: Run, path: string, base: string): Promise<IgnoreRule[]> {
  run.request.budget.check();
  const bytes = await run.request.filesystem.readFile(path);
  run.request.budget.check();
  if (!bytes) return [];
  if (bytes.length > 64 * 1024) throw new Error("ignore limit");
  const rules = await parseIgnore(decoder.decode(bytes), base, run.request.budget);
  await run.request.budget.checkpoint();
  return rules;
}

async function walk(
  run: Run,
  path: string,
  tree: Tree,
  inherited: readonly IgnoreRule[],
  excluded = false,
  missing = false,
): Promise<void> {
  await run.request.budget.checkpoint();
  if (++run.directories > 2000) throw new Error("directory limit");
  const entry = missing ? undefined : await run.request.filesystem.lookup(pathAt(run, path));
  run.request.budget.check();
  if (!path && entry?.kind !== "dir") throw new Error("missing worktree");
  const directory = entry?.kind === "dir" ? entry : undefined;
  const own = excluded ? undefined : directory?.children.get(".gitignore");
  const rules =
    own?.kind === "file"
      ? inherited.concat(
          await readRules(run, pathAt(run, path ? `${path}/.gitignore` : ".gitignore"), path),
        )
      : inherited;
  await trackedFiles(run, path, tree, directory);
  for (const [name, child] of tree.directories) {
    const relative = path ? `${path}/${name}` : name;
    await walk(
      run,
      relative,
      child,
      rules,
      excluded || (await ignored(relative, true, rules, run.request.budget)),
      !directory,
    );
  }
  if (excluded || !directory || (!run.request.config.counts && run.counts.untracked)) return;
  const names = await untrackedNames(run, path, tree, directory, rules);
  for (const name of names) {
    const metadata = directory.children.get(name);
    const relative = path ? `${path}/${name}` : name;
    if (metadata?.kind !== "dir" || (await containsUntracked(run, relative, rules)))
      add(run, "untracked");
    if (!run.request.config.counts && run.counts.untracked) return;
  }
}

async function trackedFiles(
  run: Run,
  path: string,
  tree: Tree,
  directory: Directory | undefined,
): Promise<void> {
  const pending: Promise<{ error: unknown } | undefined>[] = [];
  try {
    for (const [name, entry] of tree.files) {
      await run.request.budget.checkpoint();
      pending.push(
        checkTracked(
          run,
          path ? `${path}/${name}` : name,
          entry,
          directory?.children.get(name),
        ).then(
          () => undefined,
          (error: unknown) => ({ error }),
        ),
      );
      if (pending.length < 8) continue;
      await finishHashes(pending);
      pending.length = 0;
    }
  } finally {
    await finishHashes(pending);
  }
}
async function finishHashes(
  pending: readonly Promise<{ error: unknown } | undefined>[],
): Promise<void> {
  const results = await Promise.all(pending);
  for (const result of results) if (result) throw result.error;
}

async function checkTracked(
  run: Run,
  path: string,
  entry: IndexEntry,
  metadata: Metadata | undefined,
): Promise<void> {
  if (
    entry.stage ||
    entry.assumeValid ||
    entry.skipWorktree ||
    (entry.mode & 0o170000) === 0o160000
  )
    return;
  if (!metadata || metadata.kind === "dir" || metadata.kind === "socket") {
    add(run, "deleted");
    return;
  }
  const expected = (entry.mode & 0o170000) === 0o120000 ? "symlink" : "file";
  if (metadata.kind !== expected) {
    add(run, "typeChanged");
    return;
  }
  if (!run.request.config.counts && run.counts.modified) return;
  if (!(await cleanFile(run, path, entry, metadata))) add(run, "modified");
}

async function cleanFile(
  run: Run,
  path: string,
  indexed: IndexEntry,
  entry: Metadata,
): Promise<boolean> {
  const version = stamp(entry);
  if (run.cache.clean.get(path) === version) return true;
  run.request.budget.check();
  const bytes =
    entry.kind === "symlink"
      ? encoder.encode(entry.target)
      : await run.request.filesystem.readFile(pathAt(run, path));
  run.request.budget.check();
  if (!bytes) throw new Error("unreadable tracked file");
  run.hashed += bytes.length;
  if (run.hashed > 8 * 1024 * 1024) throw new Error("hash limit");
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const blob = new Uint8Array(header.length + bytes.length);
  blob.set(header);
  blob.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", blob));
  run.request.budget.check();
  const clean = hex(digest) === indexed.oid && !indexed.intentToAdd;
  const confirmed = await run.request.filesystem.filesystem.lookup(pathAt(run, path));
  run.request.budget.check();
  if (!confirmed || stamp(confirmed) !== version) throw new Error("file changed while hashing");
  // A same-tick write can retain the millisecond stat. Never cache that racy observation.
  if (clean && entry.mtime < Date.now() - 1) run.cache.clean.set(path, version);
  return clean;
}

async function untrackedNames(
  run: Run,
  path: string,
  tree: Tree,
  directory: Directory,
  rules: readonly IgnoreRule[],
): Promise<readonly string[]> {
  const key = `${stamp(directory)}:${JSON.stringify(rules)}`;
  const cached = run.cache.untracked.get(path);
  if (cached?.stamp === key) return cached.names;
  const names: string[] = [];
  let index = 0;
  for (const [name, entry] of directory.children) {
    if (index++ % 64 === 0) await run.request.budget.checkpoint();
    if (
      name === ".git" ||
      tree.files.has(name) ||
      (tree.directories.has(name) && entry.kind === "dir")
    )
      continue;
    const relative = path ? `${path}/${name}` : name;
    if (!(await ignored(relative, entry.kind === "dir", rules, run.request.budget)))
      names.push(name);
  }
  run.cache.untracked.set(path, { stamp: key, names });
  return names;
}

async function containsUntracked(
  run: Run,
  path: string,
  inherited: readonly IgnoreRule[],
): Promise<boolean> {
  await run.request.budget.checkpoint();
  if (++run.directories > 2000) throw new Error("directory limit");
  const directory = await run.request.filesystem.lookup(pathAt(run, path));
  run.request.budget.check();
  if (directory?.kind !== "dir") throw new Error("directory changed");
  const own = directory.children.get(".gitignore");
  const rules =
    own?.kind === "file"
      ? inherited.concat(await readRules(run, pathAt(run, `${path}/.gitignore`), path))
      : inherited;
  const names = await untrackedNames(
    run,
    path,
    { files: new Map(), directories: new Map() },
    directory,
    rules,
  );
  for (const name of names) {
    const child = directory.children.get(name);
    if (child?.kind !== "dir" || (await containsUntracked(run, `${path}/${name}`, rules)))
      return true;
  }
  return false;
}

export { renderGitStatus } from "../segments/git_status";
