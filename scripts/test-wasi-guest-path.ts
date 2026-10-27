import assert from "node:assert/strict";
import test from "node:test";
import { wasiGuestFilename } from "./wasi-guest-path.ts";

test("WASI guest source accepts stems and filenames", () => {
  assert.equal(wasiGuestFilename("env"), "env.wasm");
  assert.equal(wasiGuestFilename("which"), "which.wasm");
  assert.equal(wasiGuestFilename("xargs.wasm"), "xargs.wasm");
});
