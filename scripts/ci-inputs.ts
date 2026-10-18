import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const nativePaths =
  /^((shell|tests\/guest)\/.*|\.cargo\/.*|rust-toolchain\.toml|sources\.lock\.json|\.github\/.*|scripts\/(ci-inputs|test-ci-inputs|prepare-wasi-tests|test-prepare-wasi-tests|wasi-build|test-wasi-build|verify-wasi-guests|test-verify-wasi-guests|build-shell|build-shell-browser|build-test-guest|test-shell-wasi|check-rust-quality|check-shell-parser)\.(ts|mjs))$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a package object");
  return value as Record<string, unknown>;
}

export function dependencyInputs(text: string) {
  const lock = object(JSON.parse(text));
  delete lock.version;
  const packages = object(lock.packages);
  delete object(packages[""]).version;
  return JSON.stringify(lock);
}

export function nativeInputs(entries: readonly string[], waffle: unknown, scripts: unknown = {}) {
  if (
    typeof waffle !== "string" ||
    !waffle.startsWith("git+https://github.com/ShaulLavo/waffle.git#")
  )
    throw new Error("Expected the pinned Waffle build dependency");
  return JSON.stringify([
    entries.filter((entry) => nativePaths.test(entry.split("\t")[1])),
    waffle,
    scripts,
  ]);
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function ciInputs(revision: string) {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  const lock = git(["show", `${revision}:package-lock.json`]);
  const pkg = object(JSON.parse(git(["show", `${revision}:package.json`])));
  const entries = git(["ls-tree", "-rz", "--full-tree", revision]).split("\0").filter(Boolean);
  return {
    dependencies: hash(dependencyInputs(lock)),
    native: hash(
      nativeInputs(
        entries,
        object(pkg.devDependencies).waffle,
        Object.fromEntries(
          Object.entries(object(pkg.scripts)).filter(([key]) =>
            [
              "build:shell",
              "test:shell:wasi",
              "check:rust",
              "build:test-guest",
              "prepare:wasi-tests",
            ].includes(key),
          ),
        ),
      ),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const current = ciInputs("HEAD");
  const baseline = process.argv[2];
  const changed = !baseline || current.native !== ciInputs(baseline).native;
  const output = `dependencies=${current.dependencies}\nnative=${current.native}\nnative-changed=${changed}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
