import { test } from "node:test";
import { verifyFamilyGuest } from "./verify-family-guests.ts";

const { basePackages } = await import("../.build/node/api.mjs");
const basePrograms = basePackages.flatMap((family) => family.programs);

test("published family guests pass final scanner and memory checks", () => {
  for (const program of basePrograms) {
    const name = program.path.slice(program.path.lastIndexOf("/") + 1);
    verifyFamilyGuest(name);
  }
});
