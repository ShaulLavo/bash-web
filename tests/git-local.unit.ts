import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import * as git from "isomorphic-git";
import fixture from "../scripts/owned-fixtures/git-local.json" with { type: "json" };
import { runGit } from "../src/utilities/git-command";
import type { GitFilesystem } from "../src/utilities/git-types";
import { gitSnapshot } from "./helpers/git-snapshot";
import { captureGit } from "./helpers/git-output";

const filesystem: GitFilesystem = {
  promises: {
    async readFile(path, encoding) {
      const bytes = await fs.readFile(path);
      const format = typeof encoding === "string" ? encoding : encoding?.encoding;
      return format ? bytes.toString("utf8") : bytes;
    },
    writeFile: fs.writeFile,
    unlink: fs.unlink,
    readdir: fs.readdir,
    async mkdir(path) {
      await fs.mkdir(path);
    },
    rmdir: fs.rmdir,
    stat: fs.stat,
    lstat: fs.lstat,
    readlink: fs.readlink,
    symlink: fs.symlink,
  },
};

async function repository(context: TestContext) {
  const root = await fs.mkdtemp("/work/tmp/bash-web-git-");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = async (argv: readonly string[]) => {
    return captureGit((invocation) => runGit(filesystem, invocation), {
      argv,
      cwd: root,
      env: fixture.provenance.environment,
    });
  };
  return { root, command };
}

for (const example of process.env.GIT_LOCAL_FULL_FIXTURE
  ? fixture.cases
  : fixture.cases.slice(0, 2)) {
  test(`native filesystem replay: ${example.id}`, async (context) => {
    const { root, command } = await repository(context);
    for (const [index, step] of example.steps.entries()) {
      const label = `${example.id} step ${index}: ${JSON.stringify(step.action)}`;
      await replayStep(root, command, step, label);
      assert.deepEqual(await gitSnapshot(filesystem, root, step.state.history), step.state, label);
    }
    const oid = await git.resolveRef({ fs: filesystem, dir: root, ref: "HEAD" });
    assert.match(oid, /^[a-f0-9]{40}$/);
  });
}

async function replayStep(
  root: string,
  command: Awaited<ReturnType<typeof repository>>["command"],
  step: (typeof fixture.cases)[number]["steps"][number],
  label: string,
) {
  if (step.action.kind === "write") {
    assert.ok(step.action.path !== undefined);
    await fs.mkdir(dirname(join(root, step.action.path)), { recursive: true });
    await fs.writeFile(join(root, step.action.path), step.action.text ?? "");
    return;
  }
  if (step.action.kind === "remove") {
    assert.ok(step.action.path !== undefined);
    return fs.unlink(join(root, step.action.path));
  }
  assert.ok(step.action.argv);
  assert.ok(step.expected);
  const result = await command(step.action.argv);
  assert.equal(result.status, step.expected.status, `${label}: ${result.stderr}`);
  if (step.expected.stdout !== null)
    assert.equal(normalize(result.stdout), step.expected.stdout, label);
  if (step.expected.stderr !== null) assert.equal(result.stderr, step.expected.stderr, label);
}

function normalize(value: string) {
  return value.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, "index <old>..<new>");
}

test("tracked stash preserves staged and unstaged content and rejects dirty apply", async (context) => {
  const { root, command } = await repository(context);
  const ok = async (...argv: string[]) => {
    const result = await command(argv);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  await ok("init");
  await fs.writeFile(`${root}/story`, "base\n");
  await ok("add", "story");
  await ok("commit", "-m", "base");
  await fs.writeFile(`${root}/story`, "stage\n");
  await ok("add", "story");
  await fs.writeFile(`${root}/story`, "stage\nwork\n");
  await ok("stash", "push", "-m", "shelved");
  assert.equal(await fs.readFile(`${root}/story`, "utf8"), "base\n");
  assert.equal((await ok("status", "--porcelain")).stdout, "");
  await fs.writeFile(`${root}/story`, "do not overwrite\n");
  assert.equal((await command(["stash", "apply"])).status, 1);
  assert.equal(await fs.readFile(`${root}/story`, "utf8"), "do not overwrite\n");
  await fs.writeFile(`${root}/story`, "base\n");
  await ok("stash", "pop", "--index");
  assert.equal(await fs.readFile(`${root}/story`, "utf8"), "stage\nwork\n");
  assert.equal((await ok("status", "--porcelain")).stdout, "MM story\n");
  assert.equal((await ok("stash", "list")).stdout, "");
});

test("unsupported remote and stash options preserve repository files", async (context) => {
  const { root, command } = await repository(context);
  await command(["init"]);
  const before = await fs.readFile(`${root}/.git/HEAD`, "utf8");
  assert.equal((await command(["clone", "https://example.invalid/repo"])).status, 129);
  assert.equal((await command(["stash", "push", "-u"])).status, 129);
  assert.equal(await fs.readFile(`${root}/.git/HEAD`, "utf8"), before);
});

test("same-sized edits with subsecond timestamps are never reported clean", async (context) => {
  const { root, command } = await repository(context);
  assert.equal((await command(["init"])).status, 0);
  await fs.writeFile(`${root}/story`, "first\n");
  await fs.utimes(`${root}/story`, 1000000000.1, 1000000000.1);
  assert.equal((await command(["add", "story"])).status, 0);
  assert.equal((await command(["commit", "-m", "base"])).status, 0);
  await fs.writeFile(`${root}/story`, "other\n");
  await fs.utimes(`${root}/story`, 1000000000.2, 1000000000.2);
  const result = await command(["status", "--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, " M story\n");
});

test("add force stages an explicitly ignored file", async (context) => {
  const { root, command } = await repository(context);
  await command(["init"]);
  await fs.writeFile(`${root}/.gitignore`, "secret\n");
  await fs.writeFile(`${root}/secret`, "local content\n");
  assert.equal((await command(["add", "secret"])).status, 1);
  const result = await command(["add", "-f", "secret"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match((await command(["status", "--porcelain"])).stdout, /^A  secret\n/m);
});
