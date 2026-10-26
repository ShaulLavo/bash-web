import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const nativePaths =
  /^((patches|shell|docs\/evidence\/licenses|tests\/guest|\.cargo|\.github|scripts)\/.*|rust-toolchain\.toml|sources\.lock\.json)$/;

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

export function nativeInputs(
  entries: readonly string[],
  waffle: unknown,
  scripts: unknown = {},
  dependencies = "",
) {
  if (
    typeof waffle !== "string" ||
    !waffle.startsWith("git+https://github.com/ShaulLavo/waffle.git#")
  )
    throw new Error("Expected the pinned Waffle build dependency");
  return JSON.stringify([
    entries.filter((entry) => nativePaths.test(entry.split("\t")[1])),
    waffle,
    scripts,
    dependencies,
  ]);
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function ciInputs(revision: string, root = resolve(import.meta.dirname, "..")) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const lock = git(["show", `${revision}:package-lock.json`]);
  const pkg = object(JSON.parse(git(["show", `${revision}:package.json`])));
  const entries = git(["ls-tree", "-rz", "--full-tree", revision]).split("\0").filter(Boolean);
  return {
    dependencies: hash(dependencyInputs(lock)),
    native: hash(
      nativeInputs(
        entries,
        object(pkg.devDependencies).waffle,
        object(pkg.scripts),
        hash(dependencyInputs(lock)),
      ),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const current = ciInputs("HEAD");
  const output = `dependencies=${current.dependencies}\nnative=${current.native}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
