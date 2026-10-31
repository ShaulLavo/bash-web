import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { TurnFilesystem } from "./fs";
import { readRepository } from "./sources/repo";
import type { PromptContext, PromptFilesystem } from "./types";

const execFile = promisify(execFileCallback);
export function context(
  cwd: string,
  variables: ReadonlyMap<string, string> = new Map(),
): PromptContext {
  return {
    turn: 1,
    cwd,
    status: 0,
    pipestatus: [0],
    durationMs: undefined,
    jobs: 0,
    columns: 80,
    rows: 24,
    lineEditor: "bash",
    ps1: "$ ",
    variables: new Map<string, string>(Array.from(variables).concat([["HOME", cwd]])),
    signal: new AbortController().signal,
  };
}

type Entry = NonNullable<Awaited<ReturnType<PromptFilesystem["lookup"]>>>;

function missing(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
}

async function fileEntry(
  path: string,
  detailed: boolean,
  directory: boolean,
  symlink: boolean,
): Promise<Entry> {
  const metadata = detailed || symlink ? await lstat(path) : { ino: 1, mtimeMs: 1 };
  const stat = { ino: Number(metadata.ino), mtime: Number(metadata.mtimeMs) };
  if (symlink) return { ...stat, kind: "symlink", target: await readlink(path) };
  if (directory) return { ...stat, kind: "dir", children: new Map() };
  return { ...stat, kind: "file" };
}

async function collectChildren(
  path: string,
  entry: Extract<Entry, { kind: "dir" }>,
  boundary: string | undefined,
  detailed: boolean,
): Promise<void> {
  const aboveBoundary =
    boundary && path !== boundary && boundary.startsWith(path.endsWith("/") ? path : `${path}/`);
  for (const child of await readdir(path, { withFileTypes: true })) {
    if (child.name === ".git" && aboveBoundary) continue;
    entry.children.set(
      child.name,
      await fileEntry(
        join(path, child.name),
        detailed,
        child.isDirectory(),
        child.isSymbolicLink(),
      ),
    );
  }
}

export function realFilesystem(boundary?: string, detailed = false): PromptFilesystem {
  return {
    async lookup(path) {
      try {
        const stat = await lstat(path);
        const entry = await fileEntry(path, true, stat.isDirectory(), stat.isSymbolicLink());
        if (entry.kind !== "dir") return entry;
        await collectChildren(path, entry, boundary, detailed);
        return entry;
      } catch (error) {
        return missing(error);
      }
    },
    async readFile(path) {
      try {
        return await readFile(path);
      } catch (error) {
        return missing(error);
      }
    },
  };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const command = execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Prompt Test",
      GIT_AUTHOR_EMAIL: "prompt@example.invalid",
      GIT_COMMITTER_NAME: "Prompt Test",
      GIT_COMMITTER_EMAIL: "prompt@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  command.child.stdin?.end();
  return (await command).stdout.trim();
}

export async function fixture(t: TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `bash-web-prompt-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function snapshot(path: string, variables?: ReadonlyMap<string, string>) {
  return readRepository(new TurnFilesystem(realFilesystem()), context(path, variables));
}

export async function makeRepository(root: string, name: string): Promise<string> {
  const repository = join(root, name);
  await execFile("git", ["init", "-q", "-b", "main", repository]);
  await git(repository, "config", "user.name", "Prompt Test");
  await git(repository, "config", "user.email", "prompt@example.invalid");
  return repository;
}
export async function makeCommittedRepository(root: string, name: string): Promise<string> {
  const repository = await makeRepository(root, name);
  await writeFile(join(repository, "tracked.txt"), "first\n");
  await git(repository, "add", "tracked.txt");
  await git(repository, "commit", "-m", "initial");
  return repository;
}
