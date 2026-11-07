import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const tsc = resolve(root, "node_modules/.bin/tsc");

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

export function readTypecheckProject(file: string) {
  const path = resolve(file);
  const result = spawnSync(tsc, ["--showConfig", "-p", path], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  const config: unknown = JSON.parse(result.stdout);
  if (!config || typeof config !== "object" || !("files" in config) || !strings(config.files))
    throw new Error(`Missing complete TypeScript root inventory: ${path}`);
  if (
    !("compilerOptions" in config) ||
    !config.compilerOptions ||
    typeof config.compilerOptions !== "object"
  )
    throw new Error(`Missing TypeScript options: ${path}`);
  const options = config.compilerOptions;
  if (!("types" in options) || !strings(options.types))
    throw new Error(`Missing environment types: ${path}`);
  return { files: config.files.map((name) => resolve(dirname(path), name)), types: options.types };
}

export function partitionTypecheckRoots(all: readonly string[], bun: readonly string[]) {
  const available = new Set(all);
  for (const path of bun) {
    if (!available.has(path)) throw new Error(`Bun root is outside the complete project: ${path}`);
  }
  const hosted = new Set(bun);
  return {
    dom: all.filter((path) => !hosted.has(path)),
    bun: all.filter((path) => hosted.has(path)),
  };
}

function check(project: string): boolean {
  const result = spawnSync(tsc, ["--noEmit", "-p", project], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function main(): number {
  const project = readTypecheckProject("tsconfig.json");
  const host = readTypecheckProject("tsconfig.bun.json");
  const roots = partitionTypecheckRoots(project.files, host.files);
  const scratchRoot = resolve(root, ".scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchRoot, "typecheck-"));
  try {
    const browser = resolve(scratch, "dom.json");
    writeFileSync(
      browser,
      JSON.stringify({ extends: resolve(root, "tsconfig.json"), files: roots.dom, include: [] }),
    );
    console.log(
      `Typecheck covers all ${project.files.length} roots: ${roots.dom.length} DOM/Node, ${roots.bun.length} Bun host.`,
    );
    const dom = check(browser);
    const bun = check(resolve(root, "tsconfig.bun.json"));
    return dom && bun ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href)
  process.exitCode = main();
