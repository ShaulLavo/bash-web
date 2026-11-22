import assert from "node:assert/strict";
import { test } from "node:test";
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

function storage(open: () => Promise<unknown>, answer: "deleted" | "missing" | "busy" = "deleted") {
  const calls: string[] = [];
  const workspaceStorage: WorkspaceStorage = {
    async open(selection) {
      calls.push(`open ${selection.mode} ${selection.name}`);
      return (await open()) as never;
    },
    async remove(selection) {
      calls.push(`delete ${selection.mode} ${selection.name}`);
      return answer;
    },
  };
  return { calls, storage: workspaceStorage };
}

test("Start fresh disposes the failed runtime, then deletes the workspace only while it still cannot be opened", async () => {
  const { calls, storage: waffle } = storage(async () => {
    throw vfsError("INVALID_VFS_FORMAT");
  });
  const result = await startFresh(
    async () => {
      calls.push("dispose");
    },
    "waffle-workspace",
    waffle,
  );
  assert.equal(result, "deleted");
  assert.deepEqual(calls, [
    "dispose",
    "open fast waffle-workspace",
    "delete fast waffle-workspace",
  ]);
});

test("a workspace another tab recovered in the meantime is kept", async () => {
  const closed: string[] = [];
  const readable = storage(async () => ({
    close: async () => {
      closed.push("closed");
    },
  }));
  assert.equal(await startFresh(undefined, "waffle-workspace", readable.storage), "readable");
  assert.deepEqual(readable.calls, ["open fast waffle-workspace"]);
  assert.deepEqual(closed, ["closed"]);
  const missing = storage(async () => "missing");
  assert.equal(await startFresh(undefined, "waffle-workspace", missing.storage), "missing");
  assert.deepEqual(missing.calls, ["open fast waffle-workspace"]);
});

test("Start fresh deletes nothing while another tab holds the workspace, or when the check itself fails", async () => {
  const held = storage(async () => "busy");
  assert.equal(await startFresh(undefined, "waffle-workspace", held.storage), "busy");
  assert.deepEqual(held.calls, ["open fast waffle-workspace"]);
  const failing = storage(async () => {
    throw new Error("Connection to Indexed Database server lost");
  });
  await assert.rejects(
    startFresh(undefined, "waffle-workspace", failing.storage),
    /Connection to Indexed Database server lost/,
  );
  assert.deepEqual(failing.calls, ["open fast waffle-workspace"]);
});

test("Start fresh still checks and deletes when disposal fails, and passes a busy delete through", async (context) => {
  context.mock.method(console, "warn", () => {});
  const { calls, storage: waffle } = storage(async () => {
    throw vfsError("INVALID_VFS_FORMAT");
  }, "busy");
  const result = await startFresh(
    async () => {
      calls.push("dispose");
      throw new Error("worker gone");
    },
    "waffle-workspace",
    waffle,
  );
  assert.equal(result, "busy");
  assert.deepEqual(calls, [
    "dispose",
    "open fast waffle-workspace",
    "delete fast waffle-workspace",
  ]);
});
