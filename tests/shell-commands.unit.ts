import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "waffle";
import { installShellCommands, UtilityConflictError } from "../src/index";
import { installUtility } from "../src/utilities/install";

const encoder = new TextEncoder();

function createMockRuntime(options?: {
  onRemove?: (path: string, opts?: { ifContent?: Uint8Array }) => Promise<void> | void;
  onWrite?: (path: string, content: Uint8Array) => Promise<void> | void;
}) {
  const files = new Map<string, Uint8Array>();
  const removeCalls: Array<{ path: string; ifContent?: Uint8Array }> = [];
  const runtime = {
    disposed: false,
    filesystem: {
      async lookup(path: string) {
        return files.has(path) ? { kind: "file" as const } : undefined;
      },
      async readFile(path: string) {
        return files.get(path);
      },
      async mkdirp() {},
      async writeFile(path: string, content: Uint8Array, writeOptions?: { exclusive?: boolean }) {
        if (writeOptions?.exclusive && files.has(path)) {
          throw new Error(`EEXIST: ${path}`);
        }
        await options?.onWrite?.(path, content);
        files.set(path, new Uint8Array(content));
      },
      async remove(path: string, removeOptions?: { ifContent?: Uint8Array }) {
        removeCalls.push({ path, ifContent: removeOptions?.ifContent });
        await options?.onRemove?.(path, removeOptions);
        const existing = files.get(path);
        if (!existing) return;
        if (removeOptions?.ifContent) {
          const expected = removeOptions.ifContent;
          if (
            existing.byteLength !== expected.byteLength ||
            existing.some((byte, index) => byte !== expected[index])
          ) {
            return;
          }
        }
        files.delete(path);
      },
      async drain() {},
    },
    registerAdapter() {
      return () => {};
    },
    registerProgram() {
      return () => {};
    },
  } as unknown as Runtime;
  return { runtime, files, removeCalls };
}

test("the public utility conflict error retains its path and reason", () => {
  const error = new UtilityConflictError("/bin/sh", "another entry already exists");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "UtilityConflictError");
  assert.equal(error.path, "/bin/sh");
  assert.equal(error.message, "Cannot install utility at /bin/sh: another entry already exists");
});

test("removeOwnedMarker uses atomic ifContent and preserves a concurrently replaced file on disposal and rollback", async () => {
  const replacement = encoder.encode("peer replacement\n");
  const { runtime, files, removeCalls } = createMockRuntime();

  const installation = await installUtility(
    runtime,
    { name: "test-atomic", path: "/bin/atomic-one", defaultUrl: new URL("file:///mock.wasm") },
    {
      workerUrl: new URL("file:///mock-worker.js"),
      module: async () => ({}) as WebAssembly.Module,
    },
  );
  // Concurrently replace the marker before disposal.
  files.set("/bin/atomic-one", replacement);
  await installation.dispose();

  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0]?.path, "/bin/atomic-one");
  assert.deepEqual(removeCalls[0]?.ifContent, encoder.encode("bash-web utility: test-atomic\n"));
  assert.deepEqual(files.get("/bin/atomic-one"), replacement);

  // Also test rollback preserving a concurrently replaced first path when a second alias fails.
  const {
    runtime: rbRuntime,
    files: rbFiles,
    removeCalls: rbRemoveCalls,
  } = createMockRuntime({
    onWrite(path) {
      if (path === "/bin/rb-two") {
        rbFiles.set("/bin/rb-one", replacement);
        throw new Error("boom on second alias");
      }
    },
  });
  await assert.rejects(
    () =>
      installUtility(
        rbRuntime,
        {
          name: "test-rb",
          path: "/bin/rb-one",
          aliases: ["/bin/rb-two"],
          defaultUrl: new URL("file:///mock.wasm"),
        },
        {
          workerUrl: new URL("file:///mock-worker.js"),
          module: async () => ({}) as WebAssembly.Module,
        },
      ),
    /boom on second alias/,
  );
  assert.equal(rbRemoveCalls.length, 1);
  assert.equal(rbRemoveCalls[0]?.path, "/bin/rb-one");
  assert.deepEqual(rbRemoveCalls[0]?.ifContent, encoder.encode("bash-web utility: test-rb\n"));
  assert.deepEqual(rbFiles.get("/bin/rb-one"), replacement);
});

test("installShellCommands rollback and dispose await blocked sibling cleanups even when another sibling rejects", async () => {
  // 1. Disposal: /bin/sh rejects immediately while /bin/bash stays blocked until released.
  const disposeGate = Promise.withResolvers<void>();
  let bashDisposeFinished = false;
  const { runtime } = createMockRuntime({
    async onRemove(path) {
      if (path === "/bin/sh") throw new Error("sh remove failed");
      if (path === "/bin/bash") {
        await disposeGate.promise;
        bashDisposeFinished = true;
      }
    },
  });
  const installed = await installShellCommands(runtime, {
    wasmUrl: new URL("file:///mock-shell.wasm"),
    workerUrl: new URL("file:///mock-worker.js"),
    executables: ["/bin/sh", "/bin/bash"],
  });
  let disposeSettled = false;
  const disposePromise = installed.dispose().then(
    () => {
      disposeSettled = true;
    },
    (error: unknown) => {
      disposeSettled = true;
      return error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposeSettled, false, "dispose() must not settle while sibling cleanup is blocked");
  assert.equal(bashDisposeFinished, false);
  disposeGate.resolve();
  const disposeError = await disposePromise;
  assert.equal(bashDisposeFinished, true);
  assert.ok(disposeError instanceof Error);

  // 2. Partial-install rollback: 3rd executable fails; 1st rejects immediately; 2nd stays blocked.
  const rollbackGate = Promise.withResolvers<void>();
  let secondRollbackFinished = false;
  const { runtime: rbRuntime } = createMockRuntime({
    onWrite(path) {
      if (path === "/bin/third") throw new Error("install third failed");
    },
    async onRemove(path) {
      if (path === "/bin/first") throw new Error("first rollback failed");
      if (path === "/bin/second") {
        await rollbackGate.promise;
        secondRollbackFinished = true;
      }
    },
  });
  let rollbackSettled = false;
  const rollbackPromise = installShellCommands(rbRuntime, {
    wasmUrl: new URL("file:///mock-shell.wasm"),
    workerUrl: new URL("file:///mock-worker.js"),
    executables: ["/bin/first", "/bin/second", "/bin/third"],
  }).then(
    () => {
      rollbackSettled = true;
      return undefined;
    },
    (error: unknown) => {
      rollbackSettled = true;
      return error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    rollbackSettled,
    false,
    "rollback must not settle while sibling cleanup is still blocked",
  );
  assert.equal(secondRollbackFinished, false);
  rollbackGate.resolve();
  const rollbackError = await rollbackPromise;
  assert.equal(secondRollbackFinished, true);
  assert.ok(rollbackError instanceof AggregateError);
  assert.equal(rollbackError.errors.length, 2);
});
