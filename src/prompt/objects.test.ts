import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { TurnFilesystem } from "./fs";
import {
  context,
  fixture,
  git,
  makeCommittedRepository,
  makeRepository,
  realFilesystem,
  snapshot,
} from "./git-test-helpers";
import { WorkBudget } from "./live";
import { parseIndex } from "./sources/index-file";
import { ObjectReader } from "./sources/object-reader";
import { readObjectStatus } from "./sources/objects";
import { aheadBehind } from "./sources/object-tree";
import { readUpstream } from "./sources/object-upstream";
import type { Known, ObjectStatus, ParsedIndex } from "./sources/index-types";

function budget(): WorkBudget {
  return new WorkBudget(new AbortController().signal, 60_000);
}
function value<T>(result: Known<T>): T {
  assert.equal(result.kind, "known");
  assert.ok(result.kind === "known");
  return result.value;
}

async function status(
  path: string,
  filesystem = realFilesystem(),
  work = budget(),
): Promise<ObjectStatus> {
  const repository = await snapshot(path);
  assert.ok(repository);
  const index = await gitIndex(repository.gitDir);
  return readObjectStatus(new TurnFilesystem(filesystem, work), repository, index, work);
}
async function gitIndex(gitDir: string): Promise<ParsedIndex> {
  try {
    return await parseIndex(await readFile(join(gitDir, "index")), budget());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { entries: [] };
    throw error;
  }
}
async function expectStaged(path: string): Promise<void> {
  const expected = Number(
    await git(path, "diff", "--cached", "--no-renames", "--name-only", "-z").then(
      (output) => output.split("\0").filter(Boolean).length,
    ),
  );
  assert.equal(value((await status(path)).staged), expected);
}
async function expectCounts(path: string): Promise<void> {
  const [ahead, behind] = (
    await git(path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
  )
    .split(/\s+/)
    .map(Number);
  assert.deepEqual(value((await status(path)).aheadBehind), { ahead, behind });
}

test("loose HEAD tree matches git for additions, deletions, rename, modes, symlinks and intent-to-add", async (t) => {
  const root = await fixture(t, "objects-loose");
  const repo = await makeCommittedRepository(root, "repo");
  await mkdir(join(repo, "nested"));
  await writeFile(join(repo, "nested/a"), "base");
  await writeFile(join(repo, "mode"), "executable");
  await symlink("tracked.txt", join(repo, "link"));
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "tree");
  await expectStaged(repo);
  await rename(join(repo, "tracked.txt"), join(repo, "renamed"));
  await writeFile(join(repo, "nested/a"), "changed");
  await chmod(join(repo, "mode"), 0o755);
  await rm(join(repo, "link"));
  await symlink("renamed", join(repo, "link"));
  await git(repo, "add", "-A");
  await writeFile(join(repo, "intent"), "not staged");
  await git(repo, "add", "-N", "intent");
  await expectStaged(repo);
  assert.equal(
    value((await status(repo)).staged),
    5,
    "rename stays deletion plus addition, not similarity-detected",
  );
});

test("unborn branch stages its ordinary index entries but not intent-to-add", async (t) => {
  const root = await fixture(t, "objects-unborn");
  const repo = await makeRepository(root, "repo");
  assert.deepEqual(await status(repo), {
    staged: { kind: "known", value: 0 },
    aheadBehind: { kind: "known", value: { ahead: 0, behind: 0 } },
  });
  await writeFile(join(repo, "new"), "first");
  await git(repo, "add", "new");
  await writeFile(join(repo, "intent"), "later");
  await git(repo, "add", "-N", "intent");
  await expectStaged(repo);
  assert.equal(value((await status(repo)).staged), 1);
});

test("upstream maps fetch refspecs, packed refs, divergence, local remotes and missing refs", async (t) => {
  const root = await fixture(t, "objects-diverged");
  const repo = await makeCommittedRepository(root, "repo");
  await git(repo, "branch", "remote");
  await git(repo, "switch", "-q", "remote");
  await writeFile(join(repo, "remote"), "remote");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "remote");
  const remote = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-q", "main");
  await writeFile(join(repo, "local"), "local");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "local");
  await git(repo, "config", "branch.main.remote", "origin");
  await git(repo, "config", "branch.main.merge", "refs/heads/remote");
  await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/tracking/origin/*");
  await git(repo, "update-ref", "refs/tracking/origin/remote", remote);
  await git(repo, "pack-refs", "--all");
  await expectCounts(repo);
  assert.deepEqual(value((await status(repo)).aheadBehind), { ahead: 1, behind: 1 });
  await git(repo, "config", "branch.main.remote", ".");
  await expectCounts(repo);
  await git(repo, "config", "branch.main.merge", "refs/heads/missing");
  assert.equal((await status(repo)).aheadBehind.kind, "unknown");
  await git(repo, "config", "--unset", "branch.main.merge");
  assert.deepEqual(value((await status(repo)).aheadBehind), { ahead: 0, behind: 0 });
});

test("equal tips read no objects during the ahead/behind walk", async () => {
  let reads = 0;
  const filesystem = new TurnFilesystem({
    lookup: async () => undefined,
    readFile: async () => {
      reads++;
      throw new Error("No object read allowed");
    },
  });
  const reader = new ObjectReader(filesystem, "/unused", budget());
  const tip = "a".repeat(40);
  assert.deepEqual(await aheadBehind(reader, tip, tip), { ahead: 0, behind: 0 });
  assert.equal(reads, 0);
});

async function history(repo: string, count: number): Promise<void> {
  let input = "";
  for (let index = 1; index <= count; index++) {
    input += `commit refs/heads/main\nmark :${index}\ncommitter Prompt Test <prompt@example.invalid> ${1_700_000_000 + index} +0000\ndata ${String(index).length}\n${index}\n`;
    if (index > 1) input += `from :${index - 1}\n`;
    input += "\n";
  }
  const result = spawnSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

test("2,000 unique commits is admitted, 2,001 is unknown without partial counts", async (t) => {
  const root = await fixture(t, "objects-cap");
  const repo = await makeRepository(root, "repo");
  await history(repo, 2_000);
  await git(repo, "config", "branch.main.remote", ".");
  await git(repo, "config", "branch.main.merge", "refs/heads/upstream");
  await git(repo, "branch", "upstream", "HEAD~1999");
  await expectCounts(repo);
  assert.deepEqual(value((await status(repo)).aheadBehind), { ahead: 1_999, behind: 0 });
  await git(repo, "commit", "--allow-empty", "-qm", "over cap");
  assert.equal((await status(repo)).aheadBehind.kind, "unknown");
});

async function packedFixture(root: string): Promise<string> {
  const repo = await makeCommittedRepository(root, "source");
  await mkdir(join(repo, "tree"));
  for (let file = 0; file < 80; file++)
    await writeFile(join(repo, `tree/file-${file}`), `file ${file}\n`);
  const base = "A long repeated line for Git delta compression.\n".repeat(2_000);
  for (let revision = 0; revision < 12; revision++) {
    await writeFile(join(repo, "large"), `${revision}\n${base}${revision}\n`);
    await writeFile(join(repo, `tree/file-${revision}`), `revision ${revision}\n`);
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", `revision ${revision}`);
  }
  await git(repo, "gc", "--aggressive", "--prune=now");
  const clone = join(root, "clone");
  await git(root, "clone", "--no-local", repo, clone);
  return clone;
}

async function verifyObjects(repo: string, delta: "offset" | "reference"): Promise<void> {
  const packDir = join(repo, ".git/objects/pack");
  const indexes = (await readdir(packDir)).filter((file) => file.endsWith(".idx"));
  assert.ok(indexes.length);
  const verification = await git(repo, "verify-pack", "-v", join(packDir, indexes[0]));
  assert.match(
    verification,
    /^[0-9a-f]{40} (?:blob|tree)\s+\d+ \d+ \d+ [1-9]/m,
    `${delta} fixture must contain real deltas`,
  );
  const reader = new ObjectReader(
    new TurnFilesystem(realFilesystem()),
    join(repo, ".git"),
    budget(),
  );
  for (const line of (await git(repo, "rev-list", "--objects", "--all")).split("\n")) {
    const name = line.split(" ")[0];
    const object = await reader.read(name);
    assert.equal(object.bytes.length, Number(await git(repo, "cat-file", "-s", name)));
  }
  const pack = await readFile(join(packDir, indexes[0].replace(/\.idx$/, ".pack")));
  const deltaTypes = verification
    .split("\n")
    .filter((line) => /^[0-9a-f]{40}\s/.test(line))
    .map((line) => (pack[Number(line.split(/\s+/)[4])] >> 4) & 7);
  assert.ok(deltaTypes.includes(delta === "offset" ? 6 : 7), `fixture must encode ${delta} deltas`);
  await writeFile(join(repo, "large"), `staged packed ${delta} change`);
  await git(repo, "add", "large");
  await expectStaged(repo);
  await git(
    repo,
    "-c",
    "user.name=Prompt",
    "-c",
    "user.email=prompt@example.invalid",
    "commit",
    "-qm",
    delta,
  );
  await expectCounts(repo);
}

test("packed clone reads Git-created offset and reference deltas and compares HEAD trees", async (t) => {
  const root = await fixture(t, "objects-packed");
  const repo = await packedFixture(root);
  await verifyObjects(repo, "offset");
  // pack-objects without --delta-base-offset emits reference deltas.
  await git(repo, "pack-objects", "--all", "--window=50", "--depth=20", join(root, "pack"));
  const fresh = (await readdir(root)).filter(
    (file) => file.endsWith(".pack") || file.endsWith(".idx"),
  );
  await rm(join(repo, ".git/objects/pack"), { recursive: true });
  await mkdir(join(repo, ".git/objects/pack"));
  for (const file of fresh) await rename(join(root, file), join(repo, ".git/objects/pack", file));
  await git(repo, "prune-packed");
  await verifyObjects(repo, "reference");
});

test("corrupt or missing objects, expired budgets and unsupported config never look clean", async (t) => {
  const root = await fixture(t, "objects-invalid");
  const repo = await makeCommittedRepository(root, "repo");
  const repository = await snapshot(repo);
  assert.ok(repository);
  const index = await gitIndex(repository.gitDir);
  const dead = new WorkBudget(AbortSignal.abort(), 1000);
  assert.deepEqual(
    await readObjectStatus(new TurnFilesystem(realFilesystem()), repository, index, dead),
    { staged: { kind: "unknown" }, aheadBehind: { kind: "unknown" } },
  );
  const name = await git(repo, "rev-parse", "HEAD^{tree}");
  await chmod(join(repo, `.git/objects/${name.slice(0, 2)}/${name.slice(2)}`), 0o600);
  await writeFile(join(repo, `.git/objects/${name.slice(0, 2)}/${name.slice(2)}`), "broken zlib");
  assert.equal((await status(repo)).staged.kind, "unknown");
  await git(repo, "config", "branch.main.remote", ".");
  await git(repo, "config", "branch.main.merge", "refs/heads/main");
  const configured = await snapshot(repo);
  assert.ok(configured);
  assert.equal(
    await readUpstream(new TurnFilesystem(realFilesystem()), configured),
    await git(repo, "rev-parse", "HEAD"),
  );
  await assert.rejects(
    () =>
      readUpstream(new TurnFilesystem(realFilesystem()), {
        ...configured,
        config: `${configured.config}\n[include]\n path = /missing\n`,
      }),
    /includes unsupported/,
  );
});

async function renderedStatus(path: string): Promise<string> {
  const { createPrompt } = await import("./index");
  const signal = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let update!: (text: string) => void;
  const changed = new Promise<string>((resolve) => {
    update = resolve;
  });
  try {
    const prompt = createPrompt({
      filesystem: realFilesystem(path, true),
      config: { newline: false, layout: ["git_status"], paintMs: 0, backgroundMs: 30_000 },
    });
    const initial = await prompt.render(
      { ...context(path, new Map([["NO_COLOR", "1"]])), signal: signal.signal },
      { signal: signal.signal, update },
    );
    if (initial) return initial;
    return await Promise.race([
      changed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("No object status update")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.abort();
  }
}

test("public provider lazily pushes staged, divergence and unknown markers without changing worktree status", async (t) => {
  const root = await fixture(t, "objects-provider");
  const repo = await makeCommittedRepository(root, "repo");
  await writeFile(join(repo, "staged"), "addition");
  await git(repo, "add", "staged");
  assert.equal(await renderedStatus(repo), "[+] ");
  await git(repo, "branch", "upstream");
  await git(
    repo,
    "-c",
    "user.name=Prompt",
    "-c",
    "user.email=prompt@example.invalid",
    "commit",
    "-qm",
    "local",
  );
  await git(repo, "switch", "-q", "upstream");
  await writeFile(join(repo, "remote"), "addition");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "remote");
  await git(repo, "switch", "-q", "main");
  await git(repo, "config", "branch.main.remote", ".");
  await git(repo, "config", "branch.main.merge", "refs/heads/upstream");
  assert.equal(await renderedStatus(repo), "[⇕] ");
  await git(repo, "config", "branch.main.merge", "refs/heads/missing");
  assert.equal(await renderedStatus(repo), "[…] ");
});

test("linked worktree compares its own index against common objects and refs", async (t) => {
  const root = await fixture(t, "objects-worktree");
  const repo = await makeCommittedRepository(root, "repo");
  const linked = join(root, "linked");
  await git(repo, "worktree", "add", "-qb", "linked", linked);
  await git(repo, "config", "branch.linked.remote", ".");
  await git(repo, "config", "branch.linked.merge", "refs/heads/main");
  await writeFile(join(linked, "tracked.txt"), "linked staged");
  await git(linked, "add", ".");
  await expectStaged(linked);
  await expectCounts(linked);
  assert.equal(value((await status(linked)).staged), 1);
  assert.equal(value((await status(repo)).staged), 0);
});

test("replacement history never reports ordinary staged or synchronized status", async (t) => {
  const root = await fixture(t, "objects-replace");
  const repo = await makeCommittedRepository(root, "repo");
  const before = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "tracked.txt"), "replacement tree");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "replacement");
  const replacement = await git(repo, "rev-parse", "HEAD");
  await git(repo, "replace", before, replacement);
  const result = await status(repo);
  assert.equal(result.staged.kind, "unknown");
  assert.equal(result.aheadBehind.kind, "unknown");
});

async function packedReplacement(repo: string): Promise<void> {
  const before = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "tracked.txt"), "replacement tree");
  await git(repo, "commit", "-qam", "replacement");
  const replacement = await git(repo, "rev-parse", "HEAD");
  const ref = `refs/replace/${before}`;
  await git(repo, "replace", before, replacement);
  await git(repo, "pack-refs", "--all");
  const loosePath = join(repo, ".git", ref);
  if (await realFilesystem().lookup(loosePath)) {
    const records = await git(repo, "for-each-ref", "--format=%(objectname) %(refname)");
    await writeFile(
      join(repo, ".git/packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${records}\n`,
    );
    await rm(loosePath);
  }
  const packed = await readFile(join(repo, ".git/packed-refs"), "utf8");
  assert.ok(packed.split("\n").includes(`${replacement} ${ref}`));
  assert.equal(await git(repo, "rev-parse", "--verify", ref), replacement);
  assert.equal(
    await git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/replace/"),
    `${ref} ${replacement}`,
  );
  assert.equal(await realFilesystem().lookup(loosePath), undefined);
  const directory = await realFilesystem().lookup(join(repo, ".git/refs/replace"));
  assert.ok(!directory || (directory.kind === "dir" && directory.children.size === 0));
  await writeFile(join(repo, ".git/refs/heads/main"), `${replacement}\n`);
  assert.equal(await readFile(join(repo, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.equal(await readFile(join(repo, ".git/refs/heads/main"), "utf8"), `${replacement}\n`);
  assert.equal(await git(repo, "rev-parse", "--verify", "HEAD"), replacement);
}

test("packed-only replacement history never reports ordinary object status with a loose HEAD", async (t) => {
  const root = await fixture(t, "objects-packed-replace");
  const repo = await makeCommittedRepository(root, "repo");
  await packedReplacement(repo);
  const result = await status(repo);
  assert.deepEqual(
    { staged: result.staged.kind, aheadBehind: result.aheadBehind.kind },
    { staged: "unknown", aheadBehind: "unknown" },
  );
});

function expectUnknownObjects(result: ObjectStatus): void {
  assert.deepEqual(result, { staged: { kind: "unknown" }, aheadBehind: { kind: "unknown" } });
}

test("packed replacements use the linked worktree common directory and public unknown marker", async (t) => {
  const root = await fixture(t, "objects-linked-packed-replace");
  const repo = await makeCommittedRepository(root, "repo");
  await packedReplacement(repo);
  const linked = join(root, "linked");
  await git(repo, "worktree", "add", "-qb", "linked", linked);
  const repository = await snapshot(linked);
  assert.ok(repository);
  assert.equal(repository.commonDir, join(repo, ".git"));
  assert.notEqual(repository.gitDir, repository.commonDir);
  assert.equal(await realFilesystem().lookup(join(repository.gitDir, "packed-refs")), undefined);
  expectUnknownObjects(await status(linked));
  assert.equal(await renderedStatus(repo), "[…] ");
  assert.equal(await renderedStatus(linked), "[…] ");
  await rm(join(repo, ".git/packed-refs"));
  assert.equal((await status(repo)).staged.kind, "known");
  assert.equal((await status(repo)).aheadBehind.kind, "known");
});

test("ordinary packed upstreams and similarly named refs preserve staged and divergence counts", async (t) => {
  const root = await fixture(t, "objects-packed-boundary");
  const repo = await makeCommittedRepository(root, "repo");
  await git(repo, "branch", "upstream");
  await writeFile(join(repo, "tracked.txt"), "local commit");
  await git(repo, "commit", "-qam", "local");
  const head = await git(repo, "rev-parse", "HEAD");
  const refs = [
    "refs/replace",
    `refs/replacements/${head}`,
    `refs/heads/topic/refs/replace/${head}`,
    "refs/heads/contains-replace",
  ];
  for (const ref of refs) await git(repo, "update-ref", ref, head);
  await git(repo, "tag", "-am", "peeled tag", "v1");
  await git(repo, "config", "branch.main.remote", ".");
  await git(repo, "config", "branch.main.merge", "refs/heads/upstream");
  await git(repo, "pack-refs", "--all");
  const packedPath = join(repo, ".git/packed-refs");
  const packed = await readFile(packedPath, "utf8");
  for (const ref of refs) assert.ok(packed.split("\n").includes(`${head} ${ref}`));
  assert.ok(packed.split("\n").includes(`^${head}`));
  await writeFile(join(repo, ".git/refs/heads/main"), `${head}\n`);
  await writeFile(join(repo, "staged"), "addition");
  await git(repo, "add", "staged");
  await expectStaged(repo);
  await expectCounts(repo);
  const filesystem = realFilesystem();
  let packedReads = 0;
  const result = await status(repo, {
    ...filesystem,
    readFile(path) {
      if (path === packedPath) packedReads++;
      return filesystem.readFile(path);
    },
  });
  assert.equal(value(result.staged), 1);
  assert.deepEqual(value(result.aheadBehind), { ahead: 1, behind: 0 });
  assert.equal(packedReads, 1, "guard and upstream share the turn's packed-ref read");
});

test("absent packed refs allow ordinary object status without a file read", async (t) => {
  const root = await fixture(t, "objects-packed-absent");
  const repo = await makeCommittedRepository(root, "repo");
  const filesystem = realFilesystem();
  const packedPath = join(repo, ".git/packed-refs");
  assert.equal(await filesystem.lookup(packedPath), undefined);
  const result = await status(repo, {
    ...filesystem,
    readFile(path) {
      assert.notEqual(path, packedPath);
      return filesystem.readFile(path);
    },
  });
  assert.equal(value(result.staged), 0);
  assert.deepEqual(value(result.aheadBehind), { ahead: 0, behind: 0 });
});

test("malformed packed refs never publish known object categories with a loose HEAD", async (t) => {
  const root = await fixture(t, "objects-packed-malformed");
  const repo = await makeCommittedRepository(root, "repo");
  const head = await git(repo, "rev-parse", "HEAD");
  const record = `${head} refs/heads/unrelated\n`;
  const invalid = [
    record.trimEnd(),
    `invalid refs/heads/unrelated\n`,
    `${head} refs/heads/../invalid\n`,
    `^${head}\n`,
    `${record}^${head}\n^${head}\n`,
    `${record}broken\n`,
    `${head} refs/replace/${head}\nbroken\n`,
  ];
  for (const contents of invalid) {
    await writeFile(join(repo, ".git/packed-refs"), contents);
    expectUnknownObjects(await status(repo));
  }
  await rm(join(repo, ".git/packed-refs"));
  await mkdir(join(repo, ".git/packed-refs"));
  expectUnknownObjects(await status(repo));
});

test("unreadable packed metadata never implies replacements are absent", async (t) => {
  const root = await fixture(t, "objects-packed-unreadable");
  const repo = await makeCommittedRepository(root, "repo");
  const head = await git(repo, "rev-parse", "HEAD");
  const packedPath = join(repo, ".git/packed-refs");
  await writeFile(packedPath, `${head} refs/heads/unrelated\n`);
  const filesystem = realFilesystem();
  expectUnknownObjects(
    await status(repo, {
      ...filesystem,
      lookup(path) {
        if (path === packedPath) throw new Error("Injected packed-ref lookup failure");
        return filesystem.lookup(path);
      },
    }),
  );
  expectUnknownObjects(
    await status(repo, {
      ...filesystem,
      readFile(path) {
        if (path === packedPath) throw new Error("Injected packed-ref read failure");
        return filesystem.readFile(path);
      },
    }),
  );
  expectUnknownObjects(
    await status(repo, {
      ...filesystem,
      readFile(path) {
        if (path === packedPath) return Promise.resolve(undefined);
        return filesystem.readFile(path);
      },
    }),
  );
});

async function expectInterruptedPackedRead(
  repo: string,
  mode: "cancel" | "deadline",
): Promise<void> {
  const packedPath = join(repo, ".git/packed-refs");
  const signal = new AbortController();
  let now = 0;
  const work = new WorkBudget(signal.signal, 1000, () => now);
  const filesystem = realFilesystem();
  let packedReads = 0;
  const result = await status(
    repo,
    {
      ...filesystem,
      async readFile(path) {
        const bytes = await filesystem.readFile(path);
        if (path !== packedPath) return bytes;
        packedReads++;
        if (mode === "cancel") signal.abort();
        else now = 1000;
        return bytes;
      },
    },
    work,
  );
  assert.equal(packedReads, 1, mode);
  expectUnknownObjects(result);
}

test("cancellation and deadline during the packed-ref read reject both object categories", async (t) => {
  const root = await fixture(t, "objects-packed-cancelled");
  const repo = await makeCommittedRepository(root, "repo");
  const head = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, ".git/packed-refs"), `${head} refs/heads/unrelated\n`);
  await expectInterruptedPackedRead(repo, "cancel");
  await expectInterruptedPackedRead(repo, "deadline");
});

test("corrupt pack trailers and mismatched index pack checksums show unknown", async (t) => {
  const root = await fixture(t, "objects-pack-checksum");
  const repo = await makeCommittedRepository(root, "repo");
  await git(repo, "gc", "--prune=now");
  const packDir = join(repo, ".git/objects/pack");
  const file = (await readdir(packDir)).find((entry) => entry.endsWith(".pack"));
  assert.ok(file);
  const path = join(packDir, file);
  const original = await readFile(path);
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1] ^= 1;
  await chmod(path, 0o600);
  await writeFile(path, corrupt);
  await assert.rejects(
    () => git(repo, "verify-pack", "-v", path.replace(/\.pack$/, ".idx")),
    /corrupt|mismatch/,
  );
  assert.equal((await status(repo)).staged.kind, "unknown");
  assert.equal(await renderedStatus(repo), "[…] ");
  await writeFile(path, original);
  const indexPath = path.replace(/\.pack$/, ".idx");
  const index = await readFile(indexPath);
  index[index.length - 40] ^= 1;
  const { createHash } = await import("node:crypto");
  index.set(createHash("sha1").update(index.subarray(0, -20)).digest(), index.length - 20);
  await chmod(indexPath, 0o600);
  await writeFile(indexPath, index);
  assert.equal((await status(repo)).staged.kind, "unknown");
});

test("unmerged paths remain conflicted, not ordinary staged changes", async (t) => {
  const root = await fixture(t, "objects-conflict");
  const repo = await makeCommittedRepository(root, "repo");
  await git(repo, "branch", "side");
  await writeFile(join(repo, "tracked.txt"), "main\n");
  await git(repo, "commit", "-qam", "main");
  await git(repo, "switch", "-q", "side");
  await writeFile(join(repo, "tracked.txt"), "side\n");
  await git(repo, "commit", "-qam", "side");
  await git(repo, "switch", "-q", "main");
  await assert.rejects(() => git(repo, "merge", "side"));
  assert.match(await git(repo, "status", "--porcelain=v2"), /^u UU /m);
  assert.equal(
    await git(repo, "diff", "--cached", "--diff-filter=U", "--name-only"),
    "tracked.txt",
  );
  assert.equal(value((await status(repo)).staged), 0);
  assert.equal(await renderedStatus(repo), "[=] ");
  await writeFile(join(repo, "staged"), "ordinary staged addition");
  await git(repo, "add", "staged");
  assert.equal(value((await status(repo)).staged), 1);
  assert.equal(await renderedStatus(repo), "[=+] ");
});
