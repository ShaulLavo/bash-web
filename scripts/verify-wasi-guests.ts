import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWasiGuest as verifyWaffleGuest } from "waffle/program-build-tools";

export { functionNames } from "waffle/program-build-tools";

export function verifyWasiGuest(
  path: string,
  sdk?: string,
  filesystemAdapter = "shell_engine::runtime::wasi",
) {
  verifyWaffleGuest(path, { sdk, filesystemAdapter });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length > 2, "Pass final Wasm guest paths to inspect");
  for (const path of process.argv.slice(2)) verifyWasiGuest(resolve(path));
}
