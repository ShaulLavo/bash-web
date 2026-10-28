import { test } from "node:test";
import { basePrograms } from "waffle-base";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { familyWasmPath, familyWasiAdapter } from "./family-assets.ts";

test("published family guests pass final scanner and memory checks", () => {
  for (const program of basePrograms) {
    const name = program.path.slice(program.path.lastIndexOf("/") + 1);
    verifyWasiGuest(familyWasmPath(name), undefined, familyWasiAdapter(name));
  }
});
