import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";

export const nodeDirectory = new URL("../.build/node/", import.meta.url);
export const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
export const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
export const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));

export async function readGuest(name: string) {
  return new Uint8Array(await readFile(resolve(directory, name)));
}

export async function prepareWaffleDirectories(
  runtime: Awaited<ReturnType<typeof api.createRuntime>>,
  paths: readonly string[],
) {
  for (const path of paths) await runtime.filesystem.mkdirp(path);
  await runtime.filesystem.drain();
}

export async function waffleFixture(context: TestContext) {
  let stop = () => {};
  installNodeWorkers();
  const runtime = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
  });
  context.after(async () => {
    stop();
    try {
      await runtime.dispose();
    } finally {
      await stopNodeWorkers();
      assert.equal(liveNodeWorkers(), 0);
    }
  });
  return {
    runtime,
    setStop(terminate: () => void) {
      stop = terminate;
    },
  };
}

export { runRoot };
