import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { shellBuild, shellFeatures } from "./shell-build.ts";

const build = shellBuild();
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
  ].concat(shellFeatures(build)),
  { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
);
const regex = tree.split("\n").filter((line) => /^regex(?:-automata|-syntax)? v/.test(line));
assert.equal(regex.length > 0, build === "full", `${build} regex dependency closure`);
console.log(JSON.stringify({ build, features: shellFeatures(build), regex, tree }, null, 2));
