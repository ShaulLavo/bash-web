import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { nativeGitFilesystem } from "../tests/helpers/git-native.ts";
import { captureGit } from "../tests/helpers/git-output.ts";

const execute = promisify(execFile);

test("npm tarball runs the patched local backend without dependency modules", async (context) => {
  const root = await mkdtemp("/work/tmp/bash-web-git-package-");
  context.after(() => rm(root, { recursive: true, force: true }));
  await execute("npm", ["pack", "--pack-destination", root], { cwd: process.cwd() });
  const archives = (await readdir(root)).filter((file) => file.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  await execute("tar", ["-xzf", `${root}/${archives[0]}`, "-C", root]);
  await assert.rejects(readFile(`${root}/package/node_modules/isomorphic-git/package.json`), {
    code: "ENOENT",
  });
  assert.match(await readFile(`${root}/package/dist/git-command.d.ts`, "utf8"), /export.*runGit/);
  assert.match(
    await readFile(`${root}/package/dist/git.NOTICES.txt`, "utf8"),
    /isomorphic-git 1\.44\.5/,
  );
  const { runGit }: typeof import("../src/utilities/git-command") = await import(
    pathToFileURL(`${root}/package/dist/git-command.js`).href
  );
  const cwd = `${root}/repository`;
  await mkdir(cwd);
  const env = {
    GIT_AUTHOR_NAME: "Package test",
    GIT_AUTHOR_EMAIL: "package@example.invalid",
    GIT_COMMITTER_NAME: "Package test",
    GIT_COMMITTER_EMAIL: "package@example.invalid",
  };
  const run = async (...argv: string[]) => {
    const result = await captureGit((invocation) => runGit(nativeGitFilesystem, invocation), {
      argv,
      cwd,
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  await run("init");
  await writeFile(`${cwd}/story`, "first\n");
  await run("add", "story");
  await run("commit", "-m", "base");
  await writeFile(`${cwd}/story`, "other\n");
  assert.equal(await run("status", "--porcelain"), " M story\n");
  await run("stash", "push", "-m", "packaged stash");
  assert.equal(await run("status"), "");
  await run("stash", "pop");
  assert.equal(await readFile(`${cwd}/story`, "utf8"), "other\n");
});
