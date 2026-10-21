import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ciInputs } from "./ci-inputs.ts";
import { wasiTestFiles } from "./prepare-wasi-tests.ts";
import { stageUtilityArtifacts, utilityNames } from "./utility-artifacts.ts";

const guests = ["shell-engine", "shell-runtime", "argv-py", "printenv-py"].concat(utilityNames);
const programs = guests.map((name) => `${name}.wasm`).concat(["test-guest.wasm", "test-spin.wasm"]);
const cliFiles = ["shell-engine", "shell-cli", "cli-sha256.txt", "cli-source.txt"];
export const nativeArtifactFiles = cliFiles.concat(
  programs,
  utilityNames.map((name) => `utility-artifacts/${name}.wasm`),
  ["utility-artifacts/source-sha256.txt", "inputs"],
  wasiTestFiles.map((name) => `wasi-tests/${name}`),
);

function source(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function checksums(directory: string): string {
  return nativeArtifactFiles
    .map((name) => {
      const hash = createHash("sha256")
        .update(readFileSync(resolve(directory, name)))
        .digest("hex");
      return `${hash}  ${name}\n`;
    })
    .join("");
}

export function verifyCiArtifacts(root: string, directory: string) {
  assert.equal(
    readFileSync(resolve(directory, "cli-source.txt"), "utf8"),
    `${source(root)}\n`,
    "Native artifacts must match this exact source",
  );
  assert.equal(
    readFileSync(resolve(directory, "inputs"), "utf8"),
    `${ciInputs("HEAD", root).native}\n`,
    "Native artifact inputs changed",
  );
  assert.deepEqual(
    readdirSync(resolve(directory, "wasi-tests")).sort(),
    wasiTestFiles.toSorted(),
    "WASI artifact selection",
  );
  assert.equal(
    readFileSync(resolve(directory, "SHA256SUMS"), "utf8"),
    checksums(directory),
    "Native artifact checksum or completeness mismatch",
  );
}

function copy(sourcePath: string, destination: string) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(sourcePath, destination);
}

export function packCiArtifacts(root: string, directory: string) {
  const release = resolve(root, ".build/shell");
  for (const name of cliFiles)
    copy(
      resolve(release, name === "shell-engine" || name === "shell-cli" ? `release/${name}` : name),
      resolve(directory, name),
    );
  for (const name of guests)
    copy(
      resolve(release, `wasm32-wasip1/release/${name}.wasm`),
      resolve(directory, `${name}.wasm`),
    );
  for (const name of ["test-guest", "test-spin"])
    copy(resolve(root, `public/programs/${name}.wasm`), resolve(directory, `${name}.wasm`));
  for (const name of utilityNames.map((name) => `${name}.wasm`).concat(["source-sha256.txt"]))
    copy(
      resolve(root, ".build/utility-artifacts", name),
      resolve(directory, "utility-artifacts", name),
    );
  writeFileSync(resolve(directory, "inputs"), `${ciInputs("HEAD", root).native}\n`);
  writeFileSync(resolve(directory, "SHA256SUMS"), checksums(directory));
  verifyCiArtifacts(root, directory);
}

export function stageCiArtifacts(root: string, directory: string) {
  verifyCiArtifacts(root, directory);
  stageUtilityArtifacts(
    root,
    resolve(directory, "utility-artifacts"),
    resolve(root, ".build/shell/wasm32-wasip1/release"),
  );
  for (const name of utilityNames.map((name) => `${name}.wasm`).concat(["source-sha256.txt"]))
    copy(
      resolve(directory, "utility-artifacts", name),
      resolve(root, ".build/utility-artifacts", name),
    );
  for (const name of cliFiles) {
    const destination = resolve(
      root,
      ".build/shell",
      name === "shell-engine" || name === "shell-cli" ? `release/${name}` : name,
    );
    copy(resolve(directory, name), destination);
    if (name === "shell-engine" || name === "shell-cli") chmodSync(destination, 0o755);
  }
  for (const name of programs)
    copy(resolve(directory, name), resolve(root, ".build/shell/wasm32-wasip1/release", name));
  for (const name of ["test-guest.wasm", "test-spin.wasm"])
    copy(resolve(directory, name), resolve(root, "public/programs", name));
  copy(
    resolve(directory, "shell-runtime.wasm"),
    resolve(root, "public/programs/shell-engine.wasm"),
  );
  for (const name of utilityNames) {
    copy(resolve(directory, `${name}.wasm`), resolve(root, `public/programs/${name}.wasm`));
    copy(resolve(directory, `${name}.wasm`), resolve(root, `dist/${name}.wasm`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const [command, directory] = process.argv.slice(2);
  assert.ok(directory && process.argv.length === 4, "Use pack|stage <artifact directory>");
  if (command === "pack") packCiArtifacts(root, resolve(directory));
  else if (command === "stage") stageCiArtifacts(root, resolve(directory));
  else throw new Error("Use pack|stage <artifact directory>");
}
