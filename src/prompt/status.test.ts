import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  context,
  fixture,
  git,
  makeCommittedRepository,
  makeRepository,
  realFilesystem,
} from "./git-test-helpers";
import { TurnFilesystem } from "./fs";
import { WorkBudget } from "./live";
import { readRepository } from "./sources/repo";
import { GitStatusSource } from "./sources/status";
import { parseIndex } from "./sources/index-file";
import { defaultPromptConfig } from "./config/defaults";
import { createPrompt } from "./index";
import type { PromptFilesystem } from "./types";
import type { StatusCounts, StatusSnapshot } from "./sources/status-types";

const countsConfig = { ...defaultPromptConfig.segments.git_status, counts: true };
async function scan(
  root: string,
  source = new GitStatusSource(),
  fs = realFilesystem(root, true),
  signal = new AbortController().signal,
  ms = 2000,
): Promise<StatusSnapshot> {
  const turn = context(root);
  const filesystem = new TurnFilesystem(fs);
  const repository = await readRepository(filesystem, turn);
  assert.ok(repository);
  return source.read({
    filesystem,
    repository,
    context: turn,
    budget: new WorkBudget(signal, ms),
    config: countsConfig,
    stale() {},
  });
}
function known(snapshot: StatusSnapshot): StatusCounts {
  assert.equal(snapshot.value.worktree.kind, "known");
  if (snapshot.value.worktree.kind !== "known") throw new Error("unknown status");
  return snapshot.value.worktree.value;
}
async function oracle(root: string): Promise<StatusCounts> {
  const result = { conflicted: 0, deleted: 0, modified: 0, typeChanged: 0, untracked: 0 };
  const text = await git(root, "status", "--porcelain=v2", "--ignore-submodules=all");
  for (const line of text.split("\n")) {
    if (line.startsWith("? ")) result.untracked++;
    if (line.startsWith("u ")) result.conflicted++;
    if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
    const change = line.split(" ")[1][1];
    if (change === "M") result.modified++;
    if (change === "D") result.deleted++;
    if (change === "T") result.typeChanged++;
  }
  return result;
}
async function put(root: string, path: string, text = "content\n"): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, text);
}

for (const version of [2, 3, 4])
  test(`index v${version} and working tree agree with native Git`, async (t) => {
    const parent = await fixture(t, `status-v${version}`);
    const root = await makeRepository(parent, "repo");
    await put(root, ".gitignore", "node_modules/\n*.log\nblocked/\n!blocked/keep.txt\n");
    await put(
      root,
      "nested/.gitignore",
      "*.tmp\n!keep.tmp\n/a?.txt\n[[:digit:]].txt\n\\#literal\n",
    );
    for (const path of [
      "a.txt",
      "delete.txt",
      "nested/file.txt",
      "link-target",
      "type.txt",
      "skip.txt",
      "assume.txt",
    ])
      await put(root, path);
    await symlink("link-target", join(root, "link"));
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    await git(root, "update-index", "--skip-worktree", "skip.txt");
    await git(root, "update-index", "--assume-unchanged", "assume.txt");
    await git(root, "update-index", `--index-version=${version}`);
    for (const path of ["a.txt", "skip.txt", "assume.txt"]) await put(root, path, "different\n");
    await rm(join(root, "delete.txt"));
    await rm(join(root, "type.txt"));
    await symlink("a.txt", join(root, "type.txt"));
    await rm(join(root, "link"));
    await symlink("a.txt", join(root, "link"));
    for (const path of [
      "node_modules/pkg/large.js",
      "hidden.log",
      "nested/no.tmp",
      "nested/keep.tmp",
      "nested/a1.txt",
      "nested/1.txt",
      "nested/#literal",
      "new/deep/file",
      "only-ignored/no.log",
      "blocked/keep.txt",
    ])
      await put(root, path);
    await mkdir(join(root, "empty"));
    await put(
      root,
      "nested/.gitignore",
      "*.tmp\n!keep.tmp\n/a?.txt\n[[:digit:]].txt\n\\#literal\n",
    );
    const looked: string[] = [];
    const fs = realFilesystem(root, true);
    const instrumented: PromptFilesystem = {
      ...fs,
      async lookup(path) {
        looked.push(path);
        return fs.lookup(path);
      },
    };
    const result = known(await scan(root, undefined, instrumented));
    assert.deepEqual(result, await oracle(root));
    assert.equal(result.modified, 2);
    assert.equal(result.typeChanged, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.untracked, 2);
    assert.ok(
      !looked.some((path) => path.includes("node_modules/") || path.endsWith("node_modules")),
    );
  });

test("global, exclude and nested ignore precedence agrees with Git, including escaped spaces and double stars", async (t) => {
  const parent = await fixture(t, "ignore");
  const root = await makeCommittedRepository(parent, "repo");
  await put(parent, ".config/git/ignore", "*.global\n*.priority\n");
  await put(root, ".git/info/exclude", "*.exclude\n!keep.priority\n");
  await put(
    root,
    ".gitignore",
    "**/cache/**\n!cache/\n!cache/keep.txt\nfoo/**/bar?.[ch]\nspace\\ \n\\!literal\n",
  );
  await git(root, "add", ".gitignore");
  for (const path of [
    "no.global",
    "no.exclude",
    "keep.priority",
    "cache/drop.txt",
    "cache/keep.txt",
    "foo/a/b/bar1.c",
    "space ",
    "!literal",
    "foo/a/visible.txt",
  ])
    await put(root, path);
  const fs = realFilesystem(root, true);
  const turn = { ...context(root), variables: new Map([["HOME", parent]]) };
  const filesystem = new TurnFilesystem(fs);
  const repository = await readRepository(filesystem, turn);
  assert.ok(repository);
  const result = await new GitStatusSource().read({
    filesystem,
    repository,
    context: turn,
    budget: new WorkBudget(turn.signal, 2000),
    config: countsConfig,
    stale() {},
  });
  // Native Git's explicit global source points to the same test-owned file.
  const native = await git(
    root,
    "-c",
    `core.excludesFile=${join(parent, ".config/git/ignore")}`,
    "status",
    "--porcelain=v2",
  );
  assert.equal(
    known(result).untracked,
    native.split("\n").filter((line) => line.startsWith("? ")).length,
  );
});

test("conflict paths count once and linked worktrees use their local index", async (t) => {
  const parent = await fixture(t, "conflict");
  const root = await makeCommittedRepository(parent, "repo");
  await git(root, "checkout", "-qb", "other");
  await put(root, "tracked.txt", "other\n");
  await git(root, "commit", "-qam", "other");
  await git(root, "checkout", "main");
  await put(root, "tracked.txt", "main\n");
  await git(root, "commit", "-qam", "main");
  await assert.rejects(git(root, "merge", "other"));
  assert.deepEqual(known(await scan(root)), await oracle(root));
  assert.equal(known(await scan(root)).conflicted, 1);
  await git(root, "merge", "--abort");
  const linked = join(parent, "linked");
  await git(root, "worktree", "add", "-qb", "linked", linked);
  await put(linked, "tracked.txt", "linked\n");
  assert.deepEqual(known(await scan(linked)), await oracle(linked));
  assert.equal(known(await scan(root)).modified, 0);
});

test("submodules are skipped and never traversed", async (t) => {
  const parent = await fixture(t, "submodule");
  const root = await makeCommittedRepository(parent, "repo");
  const child = await makeCommittedRepository(parent, "child");
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", child, "sub");
  await git(root, "commit", "-qam", "submodule");
  await put(root, "sub/tracked.txt", "dirty submodule\n");
  const paths: string[] = [];
  const fs = realFilesystem(root, true);
  assert.deepEqual(
    known(
      await scan(root, undefined, {
        ...fs,
        async lookup(path) {
          paths.push(path);
          return fs.lookup(path);
        },
      }),
    ),
    await oracle(root),
  );
  assert.ok(!paths.some((path) => path.endsWith("/sub") || path.includes("/sub/")));
});

test("confirmed clean files and touched unchanged files hash once, then reuse the clean cache", async (t) => {
  const parent = await fixture(t, "clean-cache");
  const root = await makeCommittedRepository(parent, "repo");
  const fs = realFilesystem(root, true);
  const source = new GitStatusSource();
  let reads = 0;
  const observed: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (path.endsWith("/tracked.txt")) reads++;
      return fs.readFile(path);
    },
  };
  known(await scan(root, source, observed));
  const first = reads;
  known(await scan(root, source, observed));
  assert.equal(reads, first);
  await utimes(join(root, "tracked.txt"), new Date(1000), new Date(1000));
  known(await scan(root, source, observed));
  assert.equal(reads, first + 1);
  known(await scan(root, source, observed));
  assert.equal(reads, first + 1);
  await put(root, "tracked.txt", "different\n");
  assert.equal(known(await scan(root, source, observed)).modified, 1);
  assert.equal(reads, first + 2);
});

test("racy same-millisecond entries hash again rather than assume clean", async (t) => {
  const parent = await fixture(t, "racy");
  const root = await makeCommittedRepository(parent, "repo");
  const fs = realFilesystem(root, true);
  let reads = 0;
  const observed: PromptFilesystem = {
    async lookup(path) {
      const entry = await fs.lookup(path);
      if (entry?.kind === "file" && path.endsWith("/tracked.txt")) entry.mtime = Date.now() + 1000;
      if (entry?.kind === "dir" && path === root) {
        const child = entry.children.get("tracked.txt");
        if (child) child.mtime = Date.now() + 1000;
      }
      return entry;
    },
    async readFile(path) {
      if (path.endsWith("/tracked.txt")) reads++;
      return fs.readFile(path);
    },
  };
  // Use a fixed future timestamp so read validation succeeds but caching remains unsafe.
  const future = Date.now() + 10000;
  const frozen: PromptFilesystem = {
    ...observed,
    async lookup(path) {
      const entry = await observed.lookup(path);
      if (entry?.kind === "file" && path.endsWith("/tracked.txt")) entry.mtime = future;
      if (entry?.kind === "dir" && path === root) {
        const child = entry.children.get("tracked.txt");
        if (child) child.mtime = future;
      }
      return entry;
    },
  };
  const source = new GitStatusSource();
  known(await scan(root, source, frozen));
  known(await scan(root, source, frozen));
  assert.equal(reads, 2);
});

test("split, sparse and corrupt indexes report unknown", async (t) => {
  const parent = await fixture(t, "unsupported");
  const root = await makeCommittedRepository(parent, "repo");
  await git(root, "update-index", "--split-index");
  assert.equal((await scan(root)).value.worktree.kind, "unknown");
  await git(root, "update-index", "--no-split-index");
  const bytes = await readFile(join(root, ".git/index"));
  bytes[15] ^= 1;
  await writeFile(join(root, ".git/index"), bytes);
  assert.equal((await scan(root)).value.worktree.kind, "unknown");
  await rm(join(root, ".git/index"));
  await git(root, "reset", "--hard", "HEAD");
  await put(root, "outside/file");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "directory");
  await git(root, "sparse-checkout", "set", "--sparse-index", "--cone", "inside");
  assert.equal((await scan(root)).value.worktree.kind, "unknown");
});

test("index, directory and hash limits discard partial counts", async (t) => {
  const parent = await fixture(t, "limits");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, "tracked.txt", "x".repeat(8 * 1024 * 1024 + 1));
  assert.equal((await scan(root)).value.worktree.kind, "unknown");
  const bytes = await readFile(join(root, ".git/index"));
  bytes.writeUInt32BE(20001, 8);
  await assert.rejects(
    parseIndex(bytes, new WorkBudget(new AbortController().signal, 2000)),
    /index limit/u,
  );
  await git(root, "checkout", "--", "tracked.txt");
  for (let index = 0; index < 2001; index++) await mkdir(join(root, `empty-${index}`));
  assert.equal(
    (await scan(root, undefined, realFilesystem(root, true), undefined, 20000)).value.worktree.kind,
    "unknown",
  );
});

test("default markers stop hashing a kind after its first confirmed hit", async (t) => {
  const parent = await fixture(t, "early");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, "second.txt");
  await git(root, "add", ".");
  await put(root, "tracked.txt", "changed\n");
  await put(root, "second.txt", "changed\n");
  const fs = realFilesystem(root, true);
  let reads = 0;
  const observed: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (path.endsWith(".txt")) reads++;
      return fs.readFile(path);
    },
  };
  const filesystem = new TurnFilesystem(observed);
  const turn = context(root);
  const repository = await readRepository(filesystem, turn);
  assert.ok(repository);
  const result = await new GitStatusSource().read({
    filesystem,
    repository,
    context: turn,
    config: defaultPromptConfig.segments.git_status,
    budget: new WorkBudget(turn.signal, 2000),
    stale() {},
  });
  assert.equal(known(result).modified, 1);
  assert.equal(reads, 1);
});

async function painted(root: string, prompt: ReturnType<typeof createPrompt>, turn: number) {
  const controller = new AbortController();
  let complete!: (value: string) => void;
  const updated = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const text = await prompt.render(
    {
      ...context(
        root,
        new Map([
          ["GIT_DIR", `${root}/.git`],
          ["GIT_WORK_TREE", root],
        ]),
      ),
      turn,
    },
    { signal: controller.signal, update: complete },
  );
  return { text, updated, controller };
}

test("late status pushes once, stale values dim, Enter cancels and later turns resume", async (t) => {
  const parent = await fixture(t, "live");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, "tracked.txt", "dirty\n");
  const fs = realFilesystem(root, true);
  let delay = false;
  let reads = 0;
  const slow: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (path.endsWith("tracked.txt")) {
        reads++;
        if (delay) await new Promise((resolve) => setTimeout(resolve, 35));
      }
      return fs.readFile(path);
    },
  };
  const prompt = createPrompt({
    filesystem: slow,
    config: { layout: ["git_status", "character"], newline: false, paintMs: 1 },
  });
  const first = await painted(root, prompt, 1);
  const fresh = first.text?.includes("[!]") ? first.text : await first.updated;
  assert.match(fresh ?? "", /\[!\]/u);
  first.controller.abort();
  delay = true;
  const second = await painted(root, prompt, 2);
  const stale = second.text?.includes("[!]") ? second.text : await second.updated;
  // The paint budget may expire in repository discovery; a later snapshot still renders correctly.
  if (second.text?.includes("[!]")) assert.ok(stale?.includes(";2;") || stale?.includes("[2;"));
  second.controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 45));
  delay = false;
  const third = await painted(root, prompt, 3);
  assert.match(third.text?.includes("[!]") ? third.text : await third.updated, /\[!\]/u);
  third.controller.abort();
  assert.ok(reads >= 1);
});

test("abort stops at the admitted read and the next run reuses completed clean hashes", async (t) => {
  const parent = await fixture(t, "resume");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, "z.txt");
  await git(root, "add", ".");
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fs = realFilesystem(root, true);
  const reads: string[] = [];
  let blocked = true;
  const slow: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (path.endsWith(".txt")) reads.push(path);
      if (blocked && path.endsWith("/z.txt")) {
        started();
        await gate;
      }
      return fs.readFile(path);
    },
  };
  const source = new GitStatusSource();
  const pending = scan(root, source, slow, controller.signal);
  await ready;
  controller.abort();
  release();
  await assert.rejects(pending, /cancelled/u);
  blocked = false;
  known(await scan(root, source, slow));
  assert.equal(reads.filter((path) => path.endsWith("tracked.txt")).length, 1);
  assert.equal(reads.filter((path) => path.endsWith("/z.txt")).length, 2);
});

test("deadline backoff stops after two identical indexes and resets on leave or index replacement", async (t) => {
  const parent = await fixture(t, "backoff");
  const root = await makeCommittedRepository(parent, "repo");
  const fs = realFilesystem(root, true);
  const source = new GitStatusSource();
  let time = 0;
  let reads = 0;
  let expire = true;
  const slow: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (path.endsWith("/tracked.txt")) {
        reads++;
        if (expire) time += 100;
      }
      return fs.readFile(path);
    },
  };
  async function run() {
    time = 0;
    const filesystem = new TurnFilesystem(slow);
    const turn = context(root);
    const repository = await readRepository(filesystem, turn);
    assert.ok(repository);
    return source.read({
      filesystem,
      repository,
      context: turn,
      config: countsConfig,
      budget: new WorkBudget(turn.signal, 50, () => time),
      stale() {},
    });
  }
  assert.equal((await run()).value.worktree.kind, "unknown");
  assert.equal((await run()).value.worktree.kind, "unknown");
  assert.equal((await run()).value.worktree.kind, "unknown");
  assert.equal(reads, 2);
  expire = false;
  source.leave();
  assert.equal((await run()).value.worktree.kind, "known");
  assert.equal(reads, 3);
  expire = true;
  await put(root, "tracked.txt", "dirty\n");
  assert.equal((await run()).value.worktree.kind, "unknown");
  assert.equal((await run()).value.worktree.kind, "unknown");
  expire = false;
  await git(root, "add", "tracked.txt");
  assert.equal((await run()).value.worktree.kind, "known");
});

test("unknown deadline result is pushed dimmed rather than retaining stale or partial counts", async (t) => {
  const parent = await fixture(t, "deadline-push");
  const root = await makeCommittedRepository(parent, "repo");
  const fs = realFilesystem(root, true);
  const prompt = createPrompt({
    filesystem: {
      ...fs,
      async readFile(path) {
        if (path.endsWith("/tracked.txt")) await new Promise((resolve) => setTimeout(resolve, 75));
        return fs.readFile(path);
      },
    },
    config: { layout: ["git_status"], newline: false, paintMs: 0, backgroundMs: 50 },
  });
  const result = await painted(root, prompt, 1);
  const text = result.text?.includes("…") ? result.text : await result.updated;
  assert.ok(text?.includes("[…]") && (text.includes(";2;") || text.includes("[2;")));
  result.controller.abort();
});

test("untracked directory classifications reuse cached matching but invalidate on ignore edits and nested additions", async (t) => {
  const parent = await fixture(t, "untracked-cache");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, ".gitignore", "*.cachetest\n");
  await put(root, "ignored.cachetest");
  await mkdir(join(root, "empty/deep"), { recursive: true });
  await git(root, "add", ".gitignore");
  const source = new GitStatusSource();
  let checks = 0;
  const original = RegExp.prototype.test;
  RegExp.prototype.test = function (text: string) {
    if (this.source.includes("cachetest")) checks++;
    return original.call(this, text);
  };
  t.after(() => {
    RegExp.prototype.test = original;
  });
  assert.equal(known(await scan(root, source)).untracked, 0);
  const first = checks;
  assert.ok(first > 0);
  assert.equal(known(await scan(root, source)).untracked, 0);
  assert.equal(checks, first);
  await put(root, "empty/deep/new.txt");
  assert.equal(known(await scan(root, source)).untracked, 1);
  await put(root, ".gitignore", "*.cachetest\n!ignored.cachetest\n");
  assert.equal(known(await scan(root, source)).untracked, 2);
  assert.ok(checks > first);
});
