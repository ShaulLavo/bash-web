import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";

export const utilityNames = [
  "env",
  "cat",
  "cut",
  "find",
  "grep",
  "head",
  "which",
  "ls",
  "mkdir",
  "sed",
  "seq",
  "sort",
  "tail",
  "uniq",
  "wc",
  "touch",
  "rm",
  "cp",
  "mv",
] as const;
const receiptName = "source-sha256.txt";

function receipt(root: string, directory: string): string {
  const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.match(source, /^[a-f0-9]{40}$/);
  const hashes = utilityNames.map((name) => {
    const path = resolve(directory, `${name}.wasm`);
    verifyWasiGuest(path);
    return `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}.wasm`;
  });
  return [`source ${source}`].concat(hashes).join("\n") + "\n";
}

function copyUtilities(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const name of utilityNames)
    copyFileSync(resolve(source, `${name}.wasm`), resolve(destination, `${name}.wasm`));
}

export function writeUtilityArtifacts(root: string, release: string, output: string) {
  const contents = receipt(root, release);
  copyUtilities(release, output);
  writeFileSync(resolve(output, receiptName), contents);
}

export function stageUtilityArtifacts(root: string, source: string, release: string) {
  assert.equal(
    readFileSync(resolve(source, receiptName), "utf8"),
    receipt(root, source),
    "Utility artifacts must match this exact source and every verified guest hash",
  );
  copyUtilities(source, release);
  console.log(`Reused verified utility artifacts from ${source}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? ".build/shell");
  writeUtilityArtifacts(
    root,
    resolve(target, "wasm32-wasip1/release"),
    resolve(root, ".build/utility-artifacts"),
  );
}
