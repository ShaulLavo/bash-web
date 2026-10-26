import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const tree = execFileSync(
  "cargo",
  [
    "tree",
    "--locked",
    "--manifest-path",
    "shell/Cargo.toml",
    "-p",
    "shell-engine",
    "--prefix",
    "none",
  ],
  { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
);
const regex = tree
  .split("\n")
  .filter((line) =>
    /^(?:regex(?:-automata|-syntax)?|fancy-regex|upstream-sed|shell-sed) v/.test(line),
  );
assert.deepEqual(regex, [], "core must not depend on utility regex crates");
console.log(JSON.stringify({ build: "core", regex, tree }, null, 2));
