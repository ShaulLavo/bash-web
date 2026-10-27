import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../dist/git-command.js";
import fixture from "./owned-fixtures/git-local.json" with { type: "json" };
import { nativeGit } from "./record-git-local.ts";
import { nativeGitFilesystem } from "../tests/helpers/git-native.ts";
import { captureGit } from "../tests/helpers/git-output.ts";
import { gitBlob } from "../tests/helpers/git-blob.ts";
import {
  mixedConflict,
  mixedConflictExpected,
  indexOnlyStash,
  indexOnlyStashExpected,
  indexOnlyStashNativeExpected,
  type GitReviewRepository,
} from "../tests/helpers/git-review-cases.ts";

async function readFile(path: string) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function repository(root: string, engine: string): GitReviewRepository {
  return {
    async run(argv) {
      if (engine === "native Git") return nativeGit(root, argv);
      return captureGit((invocation) => runGit(nativeGitFilesystem, invocation), {
        argv,
        cwd: root,
        env: fixture.provenance.environment,
      });
    },
    write: (path, text) => fs.writeFile(`${root}/${path}`, text),
    remove: (path) => fs.unlink(`${root}/${path}`),
    read: (path) => readFile(`${root}/${path}`),
    async blob(ref, path) {
      if (engine === "backend") return gitBlob(nativeGitFilesystem, root, ref, path);
      const result = nativeGit(root, ["show", ref === "INDEX" ? `:${path}` : `${ref}:${path}`]);
      return result.status === 0 ? result.stdout : null;
    },
  };
}

function check(
  engine: string,
  name: string,
  scenario: (repository: GitReviewRepository) => Promise<unknown>,
  expected: unknown,
) {
  test(`${engine}: ${name}`, async (context) => {
    const root = await fs.mkdtemp(join(tmpdir(), "bash-web-git-review-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const actual = await scenario(repository(root, engine));
    console.log(JSON.stringify({ engine, name, actual }));
    assert.deepEqual(actual, expected);
  });
}

for (const engine of ["native Git", "backend"]) {
  check(engine, "mixed conflict keeps clean merged entries", mixedConflict, mixedConflictExpected);
  check(
    engine,
    "stash restores an index-only addition",
    indexOnlyStash,
    engine === "native Git" ? indexOnlyStashNativeExpected : indexOnlyStashExpected,
  );
}
