import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { workspaceLockNames } from "./indexeddb-workspace.ts";
import { startFresh, unreadableWorkspace, type WorkspaceStorage } from "./start-fresh.ts";

const vfsError = (code: string) =>
  Object.assign(new Error(code), { name: "VfsError", code, vfs: "indexeddb" });

test("only a stored format Waffle cannot read offers Start fresh", () => {
  assert.equal(unreadableWorkspace(vfsError("INVALID_VFS_FORMAT"), { status: "opening" }), true);
  assert.equal(
    unreadableWorkspace(
      new Error("mkdirp failed", { cause: vfsError("INVALID_VFS_FORMAT") }),
      undefined,
    ),
    true,
  );
  assert.equal(
    unreadableWorkspace(new Error("other"), {
      status: "failed",
      error: vfsError("INVALID_VFS_FORMAT"),
    }),
    true,
  );
});

test("failures a retry can fix keep the workspace and offer no Start fresh", () => {
  // A filesystem worker that did not load, a lost IndexedDB connection, full storage and missing
  // browser support all open the same workspace on a retry.
  const retryable = [
    new Error("Failed to load worker script fs-worker.js"),
    new Error("Connection to Indexed Database server lost. Refresh the page to try again"),
    new DOMException("full", "QuotaExceededError"),
    vfsError("UNSUPPORTED_VFS"),
    new RangeError("Out of memory"),
  ];
  for (const error of retryable)
    assert.equal(unreadableWorkspace(error, { status: "failed", error }), false);
  assert.equal(unreadableWorkspace(new Error("engine missing"), { status: "ready" }), false);
  assert.equal(unreadableWorkspace("INVALID_VFS_FORMAT", undefined), false);
});

test("the reset takes the lock names Waffle's IndexedDB owners use", () => {
  // The names are Waffle internals; this fails when a Waffle update renames either one.
  const [maintenance, writer] = workspaceLockNames("${name}");
  const source = (file: string) =>
    readFileSync(new URL(`../../node_modules/waffle/fs/${file}`, import.meta.url), "utf8");
  assert.ok(source("storage-maintenance.ts").includes(maintenance), maintenance);
  assert.ok(source("indexeddb.ts").includes(writer), writer);
  assert.ok(source("idle-owner.ts").includes(writer), writer);
});

function storage(answer: Awaited<ReturnType<WorkspaceStorage["remove"]>>) {
  const calls: string[] = [];
  const workspaceStorage: WorkspaceStorage = {
    async remove(selection) {
      calls.push(`remove ${selection.name}`);
      return answer;
    },
  };
  return { calls, storage: workspaceStorage };
}

test("Start fresh disposes the failed runtime before it claims the workspace", async () => {
  const { calls, storage: waffle } = storage("deleted");
  const result = await startFresh(
    async () => {
      calls.push("dispose");
    },
    "waffle-workspace",
    waffle,
  );
  assert.equal(result, "deleted");
  assert.deepEqual(calls, ["dispose", "remove waffle-workspace"]);
});

test("Start fresh passes every reason for deleting nothing through", async () => {
  for (const answer of ["missing", "busy", "readable"] as const) {
    const { calls, storage: waffle } = storage(answer);
    assert.equal(await startFresh(undefined, "waffle-workspace", waffle), answer);
    assert.deepEqual(calls, ["remove waffle-workspace"]);
  }
});

test("Start fresh surfaces a failing claim and still removes nothing it did not check", async () => {
  const failing: WorkspaceStorage = {
    async remove() {
      throw new Error("Connection to Indexed Database server lost");
    },
  };
  await assert.rejects(
    startFresh(undefined, "waffle-workspace", failing),
    /Connection to Indexed Database server lost/,
  );
});

test("Start fresh still claims the workspace when disposal fails", async (context) => {
  context.mock.method(console, "warn", () => {});
  const { calls, storage: waffle } = storage("deleted");
  const result = await startFresh(
    async () => {
      calls.push("dispose");
      throw new Error("worker gone");
    },
    "waffle-workspace",
    waffle,
  );
  assert.equal(result, "deleted");
  assert.deepEqual(calls, ["dispose", "remove waffle-workspace"]);
});
