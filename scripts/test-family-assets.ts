import { test } from "node:test";
import { basePrograms } from "waffle-base";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { familyWasmPath } from "./family-assets.ts";

test("published family guests pass final scanner and memory checks", () => {
  const cooperative = new Set(["cat", "grep", "mkdir", "seq", "tail"]);
  for (const program of basePrograms) {
    const name = program.path.slice(program.path.lastIndexOf("/") + 1);
    verifyWasiGuest(
      familyWasmPath(name),
      undefined,
      cooperative.has(name) ? "waffle_program_support::runtime::wasi" : undefined,
    );
  }
});
