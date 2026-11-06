import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createPrompt } from "./index";
import { TurnFilesystem } from "./fs";
import { WorkBudget } from "./live";
import { resolveRef } from "./sources/repo-refs";
import { readRef, readRepository } from "./sources/repo";
import { composePrompt } from "./compose";
import { resolvePromptConfig } from "./config/defaults";
import type { PromptFilesystem } from "./types";
import {
  context,
  git,
  fixture,
  snapshot,
  makeRepository,
  makeCommittedRepository,
  realFilesystem,
} from "./git-test-helpers";

const execFile = promisify(execFileCallback);

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
  if (!updates.length && !result) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      updateReady,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1_900);
      }),
    ]);
    clearTimeout(timer);
  }
  return updates.at(-1) ?? result ?? "";
}

async function expectBranch(path: string, branch: string): Promise<void> {
  assert.equal(await renderGit(path, ["git_branch"]), `on  ${branch} `);
}

test("reads attached, unborn and detached HEADs from a real repository", async (t) => {
  const root = await fixture(t, "git-head");
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
  const root = await fixture(t, "git-layout");
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
  const root = await fixture(t, "git-state");
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
  const root = await fixture(t, "git-format");
  const sha = join(root, "sha256");
  const reftable = join(root, "reftable");
  await execFile("git", ["init", "-q", "--object-format=sha256", sha]);
  await execFile("git", ["init", "-q", "--ref-format=reftable", reftable]);
  assert.equal(await renderGit(sha, ["git_branch"]), "on  ? ");
  assert.equal(await renderGit(reftable, ["git_branch"]), "on  ? ");
});

test("does not inspect unrelated paths when no repository exists", async (t) => {
  const root = await fixture(t, "git-none");
  const paths: string[] = [];
  const base = realFilesystem(root);
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
  const expected: string[] = [join(root, "nested")];
  let path = root;
  while (path !== "/") {
    expected.push(path);
    path = dirname(path);
  }
  expected.push("/");
  assert.deepEqual(paths, expected);
  assert.ok(!paths.some((path) => path.includes("/.git/")));
});

test("discovers a new parent repository on the next prompt and chooses the nearest root", async (t) => {
  const root = await fixture(t, "git-discovery");
  const nested = join(root, "parent", "child");
  await mkdir(nested, { recursive: true });
  const fs = realFilesystem(root);
  const read = () => readRepository(new TurnFilesystem(fs), context(nested));
  assert.equal(await read(), undefined);
  await git(root, "init", "-q", "-b", "parent", join(root, "parent"));
  assert.equal((await read())?.root, dirname(nested));
  await git(root, "init", "-q", "-b", "child", nested);
  const child = await read();
  assert.equal(child?.root, nested);
  assert.deepEqual(child?.head, { kind: "attached", branch: "child", commit: undefined });
});

test("separate gitdir files and relative explicit paths match git", async (t) => {
  const root = await fixture(t, "git-separate");
  const tree = join(root, "tree");
  const data = join(root, "metadata");
  await git(root, "init", "-q", "-b", "separate", `--separate-git-dir=${data}`, tree);
  await writeFile(join(tree, ".git"), `gitdir: ${relative(tree, data)}\n`);
  assert.equal((await snapshot(tree))?.gitDir, data);
  const explicit = await snapshot(
    root,
    new Map([
      ["GIT_DIR", "tree/.git"],
      ["GIT_WORK_TREE", "tree"],
    ]),
  );
  assert.equal(explicit?.gitDir, data);
  assert.equal(explicit?.root, tree);
  assert.equal(
    await git(root, "--git-dir=metadata", "--work-tree=tree", "symbolic-ref", "--short", "HEAD"),
    "separate",
  );
  const noGitDir = await snapshot(tree, new Map([["GIT_WORK_TREE", "../elsewhere"]]));
  assert.equal(noGitDir?.root, join(root, "elsewhere"));
});

test("resolves packed and symbolic HEAD refs without reading objects or following unsafe refs", async (t) => {
  const root = await fixture(t, "git-refs");
  const repo = await makeCommittedRepository(root, "repo");
  const commit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "pack-refs", "--all", "--prune");
  await git(repo, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/alias");
  assert.deepEqual((await snapshot(repo))?.head, { kind: "attached", branch: "alias", commit });
  assert.equal(
    await readRef(new TurnFilesystem(realFilesystem()), join(repo, ".git"), "refs/heads/alias"),
    commit,
  );
  await writeFile(join(repo, ".git/refs/heads/alias"), "ref: refs/heads/alias\n");
  assert.deepEqual((await snapshot(repo))?.head, { kind: "unknown" });
  let reads = 0;
  const filesystem: PromptFilesystem = {
    lookup: async () => {
      reads++;
      return undefined;
    },
    readFile: async () => {
      reads++;
      return undefined;
    },
  };
  assert.equal(
    await readRef(new TurnFilesystem(filesystem), join(repo, ".git"), "refs/../../private"),
    undefined,
  );
  assert.equal(reads, 0);
});

test("operation precedence and progress reject partial and invalid counts", async (t) => {
  const root = await fixture(t, "git-precedence");
  const repo = await makeCommittedRepository(root, "repo");
  const dir = join(repo, ".git");
  const commit = await git(repo, "rev-parse", "HEAD");
  for (const [marker, kind] of [
    ["BISECT_LOG", "bisect"],
    ["REVERT_HEAD", "revert"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["MERGE_HEAD", "merge"],
  ]) {
    await writeFile(join(dir, marker), `${commit}\n`);
    assert.equal((await snapshot(repo))?.operation?.kind, kind);
  }
  const apply = join(dir, "rebase-apply");
  await mkdir(apply);
  await writeFile(join(apply, "next"), "2\n");
  await writeFile(join(apply, "last"), "5\n");
  assert.deepEqual((await snapshot(repo))?.operation, {
    kind: "rebase",
    progress: { current: 2, total: 5 },
  });
  await writeFile(join(apply, "applying"), "");
  assert.equal((await snapshot(repo))?.operation?.kind, "am");
  const merge = join(dir, "rebase-merge");
  await mkdir(merge);
  await writeFile(join(merge, "msgnum"), "7\n");
  await writeFile(join(merge, "end"), "5\n");
  assert.deepEqual((await snapshot(repo))?.operation, { kind: "rebase", progress: undefined });
  await writeFile(join(merge, "msgnum"), "2\n");
  assert.deepEqual((await snapshot(repo))?.operation, {
    kind: "rebase",
    progress: { current: 2, total: 5 },
  });
  await rm(join(merge, "end"));
  assert.deepEqual((await snapshot(repo))?.operation, { kind: "rebase", progress: undefined });
});

test("stash distinguishes absent, loose, packed, missing logs and count boundaries", async (t) => {
  const root = await fixture(t, "git-stash");
  const repo = await makeCommittedRepository(root, "repo");
  assert.deepEqual((await snapshot(repo))?.stash, { present: false });
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await git(repo, "stash", "push", "-m", "test");
  assert.deepEqual((await snapshot(repo))?.stash, { present: true, count: 1 });
  const log = join(repo, ".git/logs/refs/stash");
  const record = await readFile(log, "utf8");
  const prefix = record.slice(0, record.indexOf("\t") + 1);
  const limitRecord = `${prefix}${"x".repeat(64 * 1024 - Buffer.byteLength(prefix) - 1)}\n`;
  await writeFile(log, limitRecord);
  assert.deepEqual((await snapshot(repo))?.stash, { present: true, count: 1 });
  await writeFile(log, `${limitRecord.slice(0, -1)}x\n`);
  assert.deepEqual((await snapshot(repo))?.stash, { present: true });
  await rm(log);
  await git(repo, "pack-refs", "--all", "--prune");
  assert.deepEqual((await snapshot(repo))?.stash, { present: true });
  await writeFile(join(repo, ".git/refs/stash"), "not an object id\n");
  assert.deepEqual((await snapshot(repo))?.stash, { present: undefined });
});

test("linked worktree operation markers stay local while refs stay common", async (t) => {
  const root = await fixture(t, "git-local");
  const repo = await makeCommittedRepository(root, "repo");
  const linked = join(root, "linked");
  await git(repo, "worktree", "add", "-q", "-b", "linked", linked);
  const local = await snapshot(linked);
  assert.ok(local);
  await writeFile(join(repo, ".git/MERGE_HEAD"), "common marker\n");
  assert.equal((await snapshot(linked))?.operation, undefined);
  await writeFile(join(local.gitDir, "CHERRY_PICK_HEAD"), "local marker\n");
  assert.equal((await snapshot(linked))?.operation?.kind, "cherry-pick");
});

test("unknown metadata stays unknown, and configured segments never read Git objects", async (t) => {
  const root = await fixture(t, "git-unknown");
  const repo = await makeCommittedRepository(root, "repo");
  const calls: string[] = [];
  const base = realFilesystem();
  const fs: PromptFilesystem = {
    lookup: async (path) => {
      calls.push(path);
      return base.lookup(path);
    },
    readFile: async (path) => {
      calls.push(path);
      return base.readFile(path);
    },
  };
  await readRepository(new TurnFilesystem(fs), context(repo));
  assert.ok(!calls.some((path) => path.includes("/objects/") || path.endsWith("/index")));
  await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/../../escape\n");
  assert.deepEqual((await snapshot(repo))?.head, { kind: "unknown" });
  await writeFile(join(repo, ".git", "commondir"), "\n");
  assert.deepEqual((await snapshot(repo))?.stash, { present: undefined });
  assert.ok(createPrompt({ filesystem: fs }).variables.includes("GIT_DIR"));
  assert.ok(createPrompt({ filesystem: fs }).variables.includes("GIT_WORK_TREE"));
});

test("the three Git segments match every retained Starship git fixture", async (t) => {
  const root = await fixture(t, "git-starship");
  const attached = await makeCommittedRepository(root, "attached");
  const unborn = await makeRepository(root, "unborn");
  const detached = await makeCommittedRepository(root, "detached");
  await git(detached, "checkout", "--detach");
  const rebase = await makeCommittedRepository(root, "rebase");
  await git(rebase, "checkout", "--detach");
  await mkdir(join(rebase, ".git/rebase-merge"));
  await writeFile(join(rebase, ".git/rebase-merge/msgnum"), "1\n");
  await writeFile(join(rebase, ".git/rebase-merge/end"), "1\n");
  const merge = await makeCommittedRepository(root, "merge");
  await writeFile(join(merge, ".git/MERGE_HEAD"), `${await git(merge, "rev-parse", "HEAD")}\n`);
  const cases = new Map([
    ["git-clean", attached],
    ["git-dirty", attached],
    ["git-untracked", attached],
    ["git-stashed", attached],
    ["git-unborn", unborn],
    ["git-detached", detached],
    ["git-mid-rebase", rebase],
    ["git-conflicted", merge],
  ]);
  const fixtureDir = join(process.cwd(), "src/prompt/fixtures/outputs");
  let compared = 0;
  for (const [name, path] of cases) {
    const repository = await snapshot(path);
    assert.ok(repository);
    const actual = composePrompt({
      context: context(path),
      config: resolvePromptConfig({
        newline: false,
        layout: ["git_branch", "git_commit", "git_state"],
      }),
      repository,
      directory: undefined,
      manifest: undefined,
      versions: {},
      environment: {},
    });
    for (const variant of await readdir(join(fixtureDir, name))) {
      const capture = await readFile(join(fixtureDir, name, variant), "utf8");
      const start = capture.indexOf("on ");
      assert.ok(start >= 0, `${name}/${variant}`);
      const ends = ["\u001b[1;31m[", "took ", "\n"]
        .map((marker) => capture.indexOf(marker, start))
        .filter((index) => index >= 0);
      let expected = capture.slice(start, Math.min(...ends));
      if (repository.head.kind === "detached")
        expected = expected.replace(/\([0-9a-f]{7}\)/u, `(${repository.head.commit.slice(0, 7)})`);
      assert.equal(actual, expected, `${name}/${variant}`);
      compared++;
    }
  }
  assert.equal(compared, 48);
});

test("corrupt packed refs cannot confirm an unborn branch or absent stash", async (t) => {
  const root = await fixture(t, "git-corrupt-packed");
  const repo = await makeCommittedRepository(root, "repo");
  await git(repo, "pack-refs", "--all", "--prune");
  await writeFile(join(repo, ".git/packed-refs"), "not a packed ref\n");
  await assert.rejects(git(repo, "rev-parse", "--verify", "HEAD"), /unexpected line/u);
  const result = await snapshot(repo);
  assert.deepEqual(result?.head, { kind: "unknown" });
  assert.deepEqual(result?.stash, { present: undefined });
  const commit = "1".repeat(40);
  await writeFile(
    join(repo, ".git/packed-refs"),
    `${commit} refs/heads/main\nmalformed later record\n`,
  );
  assert.deepEqual((await snapshot(repo))?.head, { kind: "unknown" });
});

test("inline config section comments do not bypass unsupported format detection", async (t) => {
  const root = await fixture(t, "git-format-comments");
  for (const comment of ["# comment", "; comment"]) {
    const repo = join(root, comment.startsWith("#") ? "hash" : "semicolon");
    await git(root, "init", "-q", "-b", "main", "--object-format=sha256", repo);
    const path = join(repo, ".git/config");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("[extensions]", `[extensions] ${comment}`),
    );
    assert.equal(await git(repo, "rev-parse", "--show-object-format"), "sha256");
    const result = await snapshot(repo);
    assert.deepEqual(result?.head, { kind: "unknown" });
    assert.deepEqual(result?.stash, { present: undefined });
  }
});

test("corrupt or incomplete stash logs preserve presence without inventing counts", async (t) => {
  const root = await fixture(t, "git-corrupt-stash");
  const repo = await makeCommittedRepository(root, "repo");
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await git(repo, "stash", "push", "-m", "test");
  const path = join(repo, ".git/logs/refs/stash");
  const valid = await readFile(path, "utf8");
  for (const contents of ["garbage\ngarbage\n", valid.slice(0, -1), `${valid}garbage\n`]) {
    await writeFile(path, contents);
    assert.deepEqual((await snapshot(repo))?.stash, { present: true });
  }
});

const refCommit = "a".repeat(40);
const packedMain = `${refCommit} refs/heads/main\n`;

class RefParsingBudget extends WorkBudget {
  checkpoints = 0;
  readCompleted = false;
  onCheckpoint: (count: number) => void = () => {};

  override async checkpoint(): Promise<void> {
    assert.ok(this.readCompleted, "parser checkpoint must follow a successful read");
    this.checkpoints++;
    await super.checkpoint();
    this.onCheckpoint(this.checkpoints);
    this.check();
  }
}

function refFiles(contents: string, loose = false, work?: RefParsingBudget): TurnFilesystem {
  const path = `/git/${loose ? "refs/heads/main" : "packed-refs"}`;
  const bytes = new TextEncoder().encode(contents);
  return new TurnFilesystem(
    {
      lookup: async (candidate) =>
        candidate === path ? { kind: "file", ino: 1, mtime: 1 } : undefined,
      readFile: async (candidate) => {
        assert.equal(candidate, path);
        if (work) work.readCompleted = true;
        return bytes;
      },
    },
    work,
  );
}

function packedBytes(size: number): string {
  const remaining = size - Buffer.byteLength(packedMain);
  const comment = `#${"x".repeat(4095)}\n`;
  const tail = remaining % comment.length;
  assert.ok(tail > 1);
  return (
    packedMain +
    comment.repeat(Math.floor(remaining / comment.length)) +
    `#${"x".repeat(tail - 2)}\n`
  );
}

function unicodeRecord(size: number): string {
  const prefix = `${refCommit} refs/heads/`;
  const remaining = size - prefix.length;
  return prefix + "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
}

for (const delta of [-1, 0, 1]) {
  test(`packed refs enforce the raw file ceiling at 1 MiB ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const contents = packedBytes(1024 * 1024 + delta);
    assert.equal(Buffer.byteLength(contents), 1024 * 1024 + delta);
    assert.deepEqual(
      await resolveRef(refFiles(contents), "/git", "refs/heads/main"),
      delta > 0 ? { kind: "unknown" } : { kind: "resolved", commit: refCommit },
    );
  });

  test(`packed refs enforce the raw record ceiling at 4096 ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const record = unicodeRecord(4096 + delta);
    assert.equal(Buffer.byteLength(record), 4096 + delta);
    assert.ok(record.length < 4096, "UTF-16 length must not stand in for bytes");
    assert.deepEqual(
      await resolveRef(refFiles(`${packedMain}${record}\n`), "/git", "refs/heads/main"),
      delta > 0 ? { kind: "unknown" } : { kind: "resolved", commit: refCommit },
    );
  });

  test(`loose refs count all raw file bytes at 4096 ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const remaining = 4096 + delta - refCommit.length - 1;
    const contents =
      refCommit + "\u3000".repeat(Math.floor(remaining / 3)) + " ".repeat(remaining % 3) + "\n";
    assert.equal(Buffer.byteLength(contents), 4096 + delta);
    assert.deepEqual(
      await resolveRef(refFiles(contents, true), "/git", "refs/heads/main"),
      delta > 0 ? { kind: "unknown" } : { kind: "resolved", commit: refCommit },
    );
  });

  test(`packed comments count raw record bytes at 4096 ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const comment = `#${"x".repeat(4095 + delta)}\n`;
    assert.deepEqual(
      await resolveRef(refFiles(packedMain + comment), "/git", "refs/heads/main"),
      delta > 0 ? { kind: "unknown" } : { kind: "resolved", commit: refCommit },
    );
  });
}

for (const kind of ["ordinary", "comments", "peeled"] as const) {
  test(`packed parsing checkpoints include every 64 ${kind} records`, async () => {
    const record = `${refCommit} refs/heads/other\n`;
    const records =
      kind === "comments"
        ? "# comment\n".repeat(128)
        : kind === "peeled"
          ? `${record}^${refCommit}\n`.repeat(64)
          : record.repeat(128);
    const work = new RefParsingBudget(new AbortController().signal, 60_000);
    assert.deepEqual(
      await resolveRef(refFiles(records + packedMain, false, work), "/git", "refs/heads/main"),
      { kind: "resolved", commit: refCommit },
    );
    assert.equal(
      work.checkpoints,
      4,
      "before parsing, after 64 and 128 records, and before return",
    );
  });
}

for (const mode of ["cancel", "deadline"] as const) {
  test(`packed parsing observes ${mode} inside an admitted file`, async () => {
    const controller = new AbortController();
    let now = 0;
    const work = new RefParsingBudget(controller.signal, 1000, () => now);
    work.onCheckpoint = (count) => {
      if (count !== 2) return;
      if (mode === "cancel") controller.abort();
      else now = 1000;
    };
    const contents = packedMain + "# comment\n".repeat(128);
    await assert.rejects(
      resolveRef(refFiles(contents, false, work), "/git", "refs/heads/main"),
      mode === "cancel" ? /cancelled/u : /deadline/u,
    );
    assert.equal(work.checkpoints, 2);
    const fresh = new RefParsingBudget(new AbortController().signal, 60_000);
    assert.deepEqual(
      await resolveRef(refFiles(contents, false, fresh), "/git", "refs/heads/main"),
      { kind: "resolved", commit: refCommit },
    );
    assert.equal(fresh.checkpoints, 4, "the same file completes with a live budget");
  });
}

for (const ref of ["refs/heads/main", "refs/heads/missing"]) {
  test(`packed parsing checks the final budget before returning ${ref}`, async () => {
    let now = 0;
    const work = new RefParsingBudget(new AbortController().signal, 1000, () => now);
    work.onCheckpoint = (count) => {
      if (count === 2) now = 1000;
    };
    await assert.rejects(resolveRef(refFiles(packedMain, false, work), "/git", ref), /deadline/u);
    assert.equal(work.checkpoints, 2);
  });
}

test("cached packed bytes still check cancellation before parsing", async () => {
  const controller = new AbortController();
  const work = new RefParsingBudget(controller.signal, 60_000);
  const filesystem = refFiles(packedMain, false, work);
  await filesystem.lookup("/git/refs/heads/main");
  await filesystem.lookup("/git/packed-refs");
  await filesystem.readFile("/git/packed-refs");
  controller.abort();
  await assert.rejects(resolveRef(filesystem, "/git", "refs/heads/main"), /cancelled/u);
  assert.equal(work.checkpoints, 1);
});

test("packed refs validate the complete file after matches and distinguish missing from unknown", async () => {
  const invalid = [
    packedMain.slice(0, -1),
    `${packedMain}broken\n`,
    `${packedMain}^${refCommit}x\n`,
    `${packedMain}#${"x".repeat(4096)}\n`,
  ];
  for (const contents of invalid) {
    assert.deepEqual(await resolveRef(refFiles(contents), "/git", "refs/heads/main"), {
      kind: "unknown",
    });
    assert.deepEqual(await resolveRef(refFiles(contents), "/git", "refs/heads/missing"), {
      kind: "unknown",
    });
  }
  assert.deepEqual(await resolveRef(refFiles(""), "/git", "refs/heads/main"), { kind: "missing" });
  assert.deepEqual(await resolveRef(refFiles(packedMain), "/git", "refs/heads/missing"), {
    kind: "missing",
  });
});

test("repository discovery contains cancellation during packed parsing as unknown", async (t) => {
  const root = await fixture(t, "git-packed-parse-cancel");
  const repo = await makeCommittedRepository(root, "repo");
  await git(repo, "pack-refs", "--all", "--prune");
  const path = join(repo, ".git/packed-refs");
  await writeFile(path, (await readFile(path, "utf8")) + "# comment\n".repeat(128));
  const controller = new AbortController();
  const work = new RefParsingBudget(controller.signal, 60_000);
  const base = realFilesystem();
  work.onCheckpoint = (count) => {
    if (count === 2) controller.abort();
  };
  const filesystem = new TurnFilesystem(
    {
      ...base,
      async readFile(candidate) {
        const bytes = await base.readFile(candidate);
        if (candidate === path) work.readCompleted = true;
        return bytes;
      },
    },
    work,
  );
  assert.deepEqual((await readRepository(filesystem, context(repo)))?.head, { kind: "unknown" });
  assert.ok(work.checkpoints >= 2);
  assert.equal((await snapshot(repo))?.head.kind, "attached");
});

test("packed record decoding does not hide a byte order mark after the first record", async () => {
  assert.deepEqual(await resolveRef(refFiles(`\uFEFF${packedMain}`), "/git", "refs/heads/main"), {
    kind: "resolved",
    commit: refCommit,
  });
  assert.deepEqual(
    await resolveRef(refFiles(`${packedMain}\uFEFF${packedMain}`), "/git", "refs/heads/main"),
    { kind: "unknown" },
  );
});
