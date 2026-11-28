import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { shellTargetDirectory } from "../wasi-build.ts";

const root = resolve(import.meta.dirname, "../..");
const metadata: {
  packages: { name: string; manifest_path: string; source: string | null }[];
} = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version=1", "--manifest-path", "shell/Cargo.toml"],
    {
      cwd: root,
      encoding: "utf8",
    },
  ),
);
const support = metadata.packages.filter(({ name }) => name === "waffle-program-support");
assert.equal(support.length, 1, "FreeBSD grep needs the same Waffle source pin as the shell");
const [{ manifest_path, source }] = support;
const gitSource =
  /^git\+https:\/\/github\.com\/ShaulLavo\/waffle\?rev=([a-f0-9]{40})#([a-f0-9]{40})$/.exec(
    source ?? "",
  );
assert.ok(gitSource, "Expected an exact Waffle Git pin");
const [, revision, commit] = gitSource;
assert.equal(revision, commit, "Waffle checkout must match the declared pin");
const waffle = resolve(dirname(manifest_path), "../..");
const temporaryRoot =
  process.env.RUNNER_TEMP ??
  process.env.TMPDIR ??
  (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const scratch = mkdtempSync(resolve(temporaryRoot, "bash-web-freebsd-grep-"));
try {
  const archive = execFileSync("git", [
    "-C",
    waffle,
    "archive",
    revision,
    "package.json",
    "tools",
    "packages/grep",
    "packages/waffle/scripts/build-wasi-libc.sh",
    "packages/waffle/patches/wasi-libc/preopen-scan.patch",
  ]);
  execFileSync("tar", ["-x", "-C", scratch], { input: archive });
  const sysrootCache = resolve(root, ".build/wasi-libc");
  mkdirSync(sysrootCache, { recursive: true });
  mkdirSync(resolve(scratch, ".build"), { recursive: true });
  symlinkSync(sysrootCache, resolve(scratch, ".build/wasi-libc"), "dir");
  process.env.GREP_SCRATCH_ROOT = scratch;
  const builder: unknown = await import(
    pathToFileURL(resolve(scratch, "packages/grep/scripts/build-grep.ts")).href
  );
  assert.ok(
    builder &&
      typeof builder === "object" &&
      "buildGrep" in builder &&
      typeof builder.buildGrep === "function",
  );
  // The upstream builder verifies the linked guest before the release packaging step.
  await builder.buildGrep({
    execute: (
      command: string,
      args: readonly string[],
      options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Uint8Array },
    ) =>
      execFileSync("timeout", ["--kill-after=2s", "600s", command].concat(args), {
        ...options,
        stdio: ["pipe", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      }),
  });
  const release = resolve(shellTargetDirectory(root), "wasm32-wasip1/release");
  mkdirSync(release, { recursive: true });
  copyFileSync(
    resolve(scratch, ".build/grep/wasm32-wasip1/release/grep.wasm"),
    resolve(release, "freebsd-grep.wasm"),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
