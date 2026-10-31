import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { context, fixture, git, makeCommittedRepository, realFilesystem } from "./git-test-helpers";
import { TurnFilesystem } from "./fs";
import { WorkBudget } from "./live";
import { readRepository } from "./sources/repo";
import { GitStatusSource } from "./sources/status";
import { renderGitStatus } from "./segments/git_status";
import { createPrompt } from "./index";
import { defaultPromptConfig } from "./config/defaults";
import type { PromptFilesystem } from "./types";

const config = { ...defaultPromptConfig.segments.git_status, counts: true };
async function scan(
  root: string,
  source = new GitStatusSource(),
  fs = realFilesystem(root, true),
  signal = new AbortController().signal,
) {
  const filesystem = new TurnFilesystem(fs);
  const turn = context(root);
  const repository = await readRepository(filesystem, turn);
  assert.ok(repository);
  return source.read({
    filesystem,
    repository,
    context: turn,
    config,
    budget: new WorkBudget(signal, 2000),
    stale() {},
  });
}
async function put(root: string, name: string, text = "content\n") {
  await mkdir(join(root, name, ".."), { recursive: true });
  await writeFile(join(root, name), text);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const pattern of ["ignored/\n", "ignored\n", "ignored/\n!ignored/new.txt\n"]) {
  test(`ignored parent with tracked files: ${JSON.stringify(pattern)}`, async (t) => {
    const parent = await fixture(t, "review-parent-ignore");
    const root = await makeCommittedRepository(parent, "repo");
    await put(root, "ignored/tracked.txt");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "tracked nested file");
    await put(root, ".gitignore", pattern);
    await git(root, "add", ".gitignore");
    await put(root, "ignored/new.txt");
    const actual = await scan(root);
    const native = await git(root, "status", "--porcelain=v2");
    console.log(JSON.stringify({ case: "ignored tracked parent", pattern, actual, native }));
    assert.equal(actual.value.worktree.kind, "known");
    assert.ok(!native.includes("? "));
    if (actual.value.worktree.kind === "known")
      assert.equal(actual.value.worktree.value.untracked, 0);
  });
}

test("tracked file obstruction retains Git deletion marker", async (t) => {
  const parent = await fixture(t, "review-type-dir");
  const root = await makeCommittedRepository(parent, "repo");
  await rm(join(root, "tracked.txt"));
  await put(root, "tracked.txt/child");
  const actual = await scan(root);
  const native = await git(root, "status", "--porcelain=v2");
  const repository = await readRepository(
    new TurnFilesystem(realFilesystem(root, true)),
    context(root),
  );
  const rendered = renderGitStatus(
    {
      context: context(root),
      repository,
      directory: undefined,
      manifest: undefined,
      versions: {},
      gitStatus: actual,
    },
    defaultPromptConfig.segments.git_status,
  );
  console.log(
    JSON.stringify({ case: "file to directory", actual, native, rendered: rendered ?? null }),
  );
  assert.equal(actual.value.worktree.kind, "known");
  assert.ok(native.includes(" .D "));
  if (actual.value.worktree.kind === "known") {
    assert.equal(actual.value.worktree.value.typeChanged, 0);
    assert.equal(actual.value.worktree.value.deleted, 1);
    assert.equal(actual.value.worktree.value.untracked, 0);
  }
});

test("cancellation drains admitted reads before a later scan starts", async (t) => {
  const parent = await fixture(t, "review-cancel");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, "z.txt");
  await git(root, "add", ".");
  const source = new GitStatusSource();
  const controller = new AbortController();
  const gate = deferred();
  t.after(() => {
    gate.resolve();
    controller.abort();
  });
  const ready = deferred();
  const fs = realFilesystem(root, true);
  let firstReadAlive = false;
  let overlapped = false;
  let reads = 0;
  const slow: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (!path.endsWith("/tracked.txt")) return fs.readFile(path);
      reads++;
      if (reads !== 1) {
        overlapped = firstReadAlive;
        return fs.readFile(path);
      }
      firstReadAlive = true;
      ready.resolve();
      controller.abort();
      await gate.promise;
      firstReadAlive = false;
      return fs.readFile(path);
    },
  };
  const pending = scan(root, source, slow, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  await ready.promise;
  let retired = false;
  void pending.catch(() => {
    retired = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(retired, false, "cancellation must drain the admitted read");
  assert.equal(firstReadAlive, true);
  const next = scan(root, source, slow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1, "the next scan must not overlap the admitted read");
  gate.resolve();
  await rejected;
  await next;
  console.log(JSON.stringify({ case: "cancel before drain", overlapped, firstReadAlive, reads }));
  assert.equal(overlapped, false);
});

test("question mark ignore matching follows native Git bytes", async (t) => {
  const parent = await fixture(t, "review-unicode-ignore");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, ".gitignore", "?.txt\n");
  await git(root, "add", ".gitignore");
  await put(root, "é.txt");
  const actual = await scan(root);
  const native = await git(root, "-c", "core.quotepath=false", "status", "--porcelain=v2");
  console.log(JSON.stringify({ case: "unicode ignore", actual, native }));
  assert.ok(native.includes("? é.txt"));
  assert.equal(actual.value.worktree.kind, "known");
  if (actual.value.worktree.kind === "known")
    assert.equal(actual.value.worktree.value.untracked, 1);
});

test("ready fast sources publish while background status is blocked", async (t) => {
  const parent = await fixture(t, "review-fast-refresh");
  const root = await makeCommittedRepository(parent, "repo");
  await put(root, "tracked.txt", "dirty\n");
  await put(root, "package.json", '{"name":"test","version":"1.2.3"}');
  const fs = realFilesystem(root, true);
  const packageGate = deferred();
  const statusGate = deferred();
  const packageReady = deferred();
  const statusReady = deferred();
  const done = deferred();
  const history: string[] = [];
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    packageGate.resolve();
    statusGate.resolve();
  });
  const slow: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      const bytes = await fs.readFile(path);
      if (path.endsWith("/package.json")) {
        packageReady.resolve();
        await packageGate.promise;
      }
      if (path.endsWith("/tracked.txt")) {
        statusReady.resolve();
        await statusGate.promise;
      }
      return bytes;
    },
  };
  const prompt = createPrompt({
    filesystem: slow,
    config: { layout: ["package", "git_status", "character"], paintMs: 0, newline: false },
  });
  const initial = await prompt.render(context(root), {
    signal: controller.signal,
    update(text) {
      history.push(text);
      if (text.includes("1.2.3")) done.resolve();
    },
  });
  assert.ok(initial !== null);
  history.push(initial);
  await Promise.all([packageReady.promise, statusReady.promise]);
  packageGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const before = history.slice();
  statusGate.resolve();
  await done.promise;
  console.log(
    JSON.stringify({
      case: "fast refresh",
      beforeStatusReleased: before,
      afterStatusReleased: history,
    }),
  );
  assert.ok(before.some((text) => text.includes("1.2.3")));
});

test("switching repositories resets deadline backoff", async (t) => {
  const parent = await fixture(t, "review-leave-backoff");
  const rootA = await makeCommittedRepository(parent, "a");
  const rootB = await makeCommittedRepository(parent, "b");
  await put(rootA, "tracked.txt", "dirty A\n");
  await put(rootB, "tracked.txt", "dirty B\n");
  const fs = realFilesystem(parent, true);
  let slow = true;
  let readsA = 0;
  const logs: string[] = [];
  const observed: PromptFilesystem = {
    ...fs,
    async readFile(path) {
      if (path === join(rootA, "tracked.txt")) {
        readsA++;
        if (slow) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return fs.readFile(path);
    },
  };
  const prompt = createPrompt({
    filesystem: observed,
    logger: (message) => logs.push(message),
    config: { layout: ["git_status"], paintMs: 0, backgroundMs: 100, newline: false },
  });
  async function paint(root: string, turn: number) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    let complete!: (text: string) => void;
    const result = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const vars = new Map([
      ["GIT_DIR", join(root, ".git")],
      ["GIT_WORK_TREE", root],
    ]);
    const text = await prompt.render(
      { ...context(root, vars), turn },
      {
        signal: controller.signal,
        update(text) {
          if (text.includes("[") && (text.includes("!") || text.includes("…"))) complete(text);
        },
      },
    );
    assert.ok(text !== null);
    const final = text.includes("!") || text.includes("…") ? text : await result;
    controller.abort();
    return final;
  }
  await paint(rootA, 1);
  await paint(rootA, 2);
  assert.equal(readsA, 2);
  slow = false;
  await paint(rootB, 3);
  const actual = await paint(rootA, 4);
  console.log(JSON.stringify({ case: "leave backoff", actual, readsA, logs }));
  assert.ok(actual.includes("[!]"));
});
