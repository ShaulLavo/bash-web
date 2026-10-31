import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createPrompt } from "./index";
import { TurnFilesystem } from "./fs";
import { readRepository } from "./sources/repo";
import type { PromptContext, PromptFilesystem } from "./types";

const execFile = promisify(execFileCallback);
function context(cwd: string, variables: ReadonlyMap<string, string> = new Map()): PromptContext {
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
    variables: new Map<string, string>([["HOME", cwd], ...Array.from(variables)]),
    signal: new AbortController().signal,
  };
}

async function lookupDirectory(
  path: string,
  stat: Awaited<ReturnType<typeof lstat>>,
): Promise<Awaited<ReturnType<PromptFilesystem["lookup"]>>> {
  const children = new Map();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const childStat = await lstat(child);
    children.set(
      entry.name,
      childStat.isDirectory()
        ? { kind: "dir", ino: Number(childStat.ino), mtime: Number(childStat.mtimeMs) }
        : { kind: "file", ino: Number(childStat.ino), mtime: Number(childStat.mtimeMs) },
    );
  }
  return { kind: "dir", ino: Number(stat.ino), mtime: Number(stat.mtimeMs), children };
}

function realFilesystem(): PromptFilesystem {
  return {
    async lookup(path) {
      try {
        const stat = await lstat(path);
        if (stat.isDirectory()) return lookupDirectory(path, stat);
        return { kind: "file", ino: Number(stat.ino), mtime: Number(stat.mtimeMs) };
      } catch {
        return undefined;
      }
    },
    async readFile(path) {
      try {
        return await readFile(path);
      } catch {
        return undefined;
      }
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, {
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
  return result.stdout.trim();
}

async function makeRepository(root: string, name: string): Promise<string> {
  const repository = join(root, name);
  await execFile("git", ["init", "-q", "-b", "main", repository]);
  await git(repository, "config", "user.name", "Prompt Test");
  await git(repository, "config", "user.email", "prompt@example.invalid");
  return repository;
}
async function makeCommittedRepository(root: string, name: string): Promise<string> {
  const repository = await makeRepository(root, name);
  await writeFile(join(repository, "tracked.txt"), "first\n");
  await git(repository, "add", "tracked.txt");
  await git(repository, "commit", "-m", "initial");
  return repository;
}

async function renderGit(
  cwd: string,
  layout: readonly ("git_branch" | "git_commit" | "git_state")[],
): Promise<string> {
  const updates: string[] = [];
  let resolveUpdate!: () => void;
  const updateReady = new Promise<void>((resolve) => {
    resolveUpdate = resolve;
  });
  const result = await createPrompt({
    filesystem: realFilesystem(),
    config: { newline: false, layout },
  }).render(context(cwd, new Map([["NO_COLOR", "1"]])), {
    signal: new AbortController().signal,
    update(text) {
      updates.push(text);
      resolveUpdate();
    },
  });
  if (!updates.length)
    await Promise.race([updateReady, new Promise((resolve) => setTimeout(resolve, 1_900))]);
  return updates.at(-1) ?? result ?? "";
}

async function expectBranch(path: string, branch: string): Promise<void> {
  assert.equal(await renderGit(path, ["git_branch"]), `on  ${branch} `);
}

test("reads attached, unborn and detached HEADs from a real repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-web-prompt-git-head-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repository = await makeCommittedRepository(root, "repo");
  await expectBranch(repository, "main");

  await git(repository, "checkout", "--detach");
  const commit = await git(repository, "rev-parse", "HEAD");
  assert.equal(
    await renderGit(repository, ["git_branch", "git_commit"]),
    `on  HEAD (${commit.slice(0, 7)}) `,
  );

  const unborn = await makeRepository(root, "unborn");
  await expectBranch(unborn, "main");
});

test("reads linked worktrees, commondir stash state, and explicit git directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-web-prompt-git-layout-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repository = await makeCommittedRepository(root, "repo");
  const linked = join(root, "linked");
  await git(repository, "worktree", "add", "-q", "-b", "linked", linked);
  const linkedGitFile = await readFile(join(linked, ".git"), "utf8");
  assert.match(linkedGitFile, /^gitdir:/u);
  await expectBranch(linked, "linked");

  await writeFile(join(repository, "tracked.txt"), "stash one\n");
  await git(repository, "stash", "push", "-m", "one");
  await writeFile(join(repository, "tracked.txt"), "stash two\n");
  await git(repository, "stash", "push", "-m", "two");
  await git(repository, "pack-refs", "--all", "--prune");
  const snapshot = await readRepository(new TurnFilesystem(realFilesystem()), context(linked));
  assert.equal(snapshot?.commonDir, join(repository, ".git"));
  assert.deepEqual(snapshot?.stash, { present: true, count: 2 });
  await writeFile(join(repository, ".git/logs/refs/stash"), Buffer.alloc(64 * 1024 + 1, 97));
  const capped = await readRepository(new TurnFilesystem(realFilesystem()), context(linked));
  assert.deepEqual(capped?.stash, { present: true });

  const workTree = join(root, "work-tree");
  await mkdir(workTree, { recursive: true });
  const explicit = await readRepository(
    new TurnFilesystem(realFilesystem()),
    context(
      workTree,
      new Map([
        ["GIT_DIR", join(repository, ".git")],
        ["GIT_WORK_TREE", workTree],
      ]),
    ),
  );
  assert.equal(explicit?.root, workTree);
  assert.equal(explicit?.head.kind, "attached");
});

test("keeps rebase precedence and reports progress from real git state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-web-prompt-git-state-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repository = await makeRepository(root, "repo");
  await writeFile(join(repository, "conflict.txt"), "base\n");
  await git(repository, "add", "conflict.txt");
  await git(repository, "commit", "-m", "base");
  await git(repository, "checkout", "-q", "-b", "topic");
  await writeFile(join(repository, "conflict.txt"), "topic\n");
  await git(repository, "commit", "-am", "topic");
  await git(repository, "checkout", "-q", "main");
  await writeFile(join(repository, "conflict.txt"), "main\n");
  await git(repository, "commit", "-am", "main");
  await git(repository, "checkout", "-q", "topic");
  await execFile("git", ["rebase", "main"], { cwd: repository }).catch(() => undefined);
  const gitDir = join(repository, ".git");
  const rebase = await readRepository(new TurnFilesystem(realFilesystem()), context(repository));
  assert.deepEqual(rebase?.operation, { kind: "rebase", progress: { current: 1, total: 1 } });
  assert.equal(
    await renderGit(repository, ["git_branch", "git_commit", "git_state"]),
    "on  HEAD (" + (await git(repository, "rev-parse", "HEAD")).slice(0, 7) + ") (REBASING 1/1) ",
  );

  await writeFile(join(gitDir, "CHERRY_PICK_HEAD"), "0000000000000000000000000000000000000000\n");
  const precedence = await readRepository(
    new TurnFilesystem(realFilesystem()),
    context(repository),
  );
  assert.equal(precedence?.operation?.kind, "rebase");
});

test("marks SHA-256 and reftable repositories unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-web-prompt-git-format-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const sha = join(root, "sha256");
  const reftable = join(root, "reftable");
  await execFile("git", ["init", "-q", "--object-format=sha256", sha]);
  await execFile("git", ["init", "-q", "--ref-format=reftable", reftable]);
  assert.equal(await renderGit(sha, ["git_branch"]), "on  ? ");
  assert.equal(await renderGit(reftable, ["git_branch"]), "on  ? ");
});

test("does not inspect unrelated paths when no repository exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-web-prompt-git-none-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const paths: string[] = [];
  const base = realFilesystem();
  const filesystem: PromptFilesystem = {
    lookup: async (path) => {
      paths.push(path);
      return base.lookup(path);
    },
    readFile: base.readFile,
  };
  await createPrompt({ filesystem, config: { newline: false, layout: ["git_branch"] } }).render(
    context(join(root, "nested"), new Map([["NO_COLOR", "1"]])),
    { signal: new AbortController().signal, update() {} },
  );
  const expected = new Set([join(root, "nested"), root, "/tmp", "/"]);
  assert.deepEqual(new Set(paths), expected);
  assert.ok(!paths.some((path) => path.includes("/.git/")));
});
