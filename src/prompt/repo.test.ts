import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createPrompt } from "./index";
import { TurnFilesystem } from "./fs";
import { readRepository } from "./sources/repo";
import type { PromptFilesystem } from "./types";

const execFile = promisify(execFileCallback);
import {
  context,
  git,
  makeRepository,
  makeCommittedRepository,
  realFilesystem,
} from "./git-test-helpers";

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
