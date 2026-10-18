import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
const machete = resolve(root, ".build/quality-tools/bin/cargo-machete");
const version = spawnSync(machete, ["--version"], { encoding: "utf8" });
assert.equal(
  version.error,
  undefined,
  "Install cargo-machete with the command in docs/code-quality.md",
);
assert.equal(version.status, 0);
assert.equal(version.stdout.trim(), "0.9.2", "Use the pinned cargo-machete version");
run("node", ["scripts/check-shell-parser.mjs"]);
run("cargo", ["fmt", "--manifest-path", "shell/Cargo.toml", "--all", "--check"]);
run("cargo", [
  "clippy",
  "--locked",
  "--manifest-path",
  "shell/Cargo.toml",
  "--workspace",
  "--all-targets",
  "--",
  "-D",
  "warnings",
]);
run("cargo", [
  "test",
  "--locked",
  "--manifest-path",
  "shell/Cargo.toml",
  "--workspace",
  "-j2",
  "--no-fail-fast",
]);
// Cargo's locked checks above validate the workspace lock before dependency analysis.
// Offline metadata prevents the dependency checker from resolving fresh registry versions.
run(machete, ["--with-metadata", "shell"], { env: { ...process.env, CARGO_NET_OFFLINE: "true" } });
