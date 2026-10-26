import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type * as Api from "./waffle-node-api.ts";

export const nodeDirectory = new URL("../.build/node/", import.meta.url);
export const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
export const directory = resolve(
  process.env.CARGO_TARGET_DIR ?? ".build/shell",
  "wasm32-wasip1/release",
);

export async function readWasiSource(name: string) {
  return new Uint8Array(await readFile(resolve(directory, `${name}.wasm`)));
}

export async function readShell() {
  return WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
}
