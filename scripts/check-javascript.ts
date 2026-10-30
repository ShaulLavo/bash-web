import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface JavaScriptException {
  kind: "generated" | "test-input";
  reason: string;
}

const root = resolve(import.meta.dirname, "..");
const javascriptExceptions: ReadonlyMap<string, JavaScriptException> = new Map();

function findHandwrittenJavaScript(
  paths: readonly string[],
  exceptions: ReadonlyMap<string, JavaScriptException> = javascriptExceptions,
): string[] {
  return paths.filter((path) => /\.(?:js|mjs|cjs)$/.test(path) && !exceptions.has(path)).sort();
}

export function checkJavaScript(
  directory: string,
  exceptions: ReadonlyMap<string, JavaScriptException> = javascriptExceptions,
): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: directory, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  const paths = result.stdout.split("\0").filter(Boolean);
  return findHandwrittenJavaScript(paths, exceptions);
}

function main() {
  const violations = checkJavaScript(root);
  if (violations.length === 0) return;
  console.error(
    `Hand-written JavaScript is not allowed. Use TypeScript or a reviewed exact-path exception.\n${violations.join("\n")}`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
