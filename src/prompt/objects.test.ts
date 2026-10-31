import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { TurnFilesystem } from "./fs";
import {
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

async function status(path: string): Promise<ObjectStatus> {
  const repository = await snapshot(path);
  assert.ok(repository);
  const index = await gitIndex(repository.gitDir);
  return readObjectStatus(new TurnFilesystem(realFilesystem()), repository, index, budget());
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
