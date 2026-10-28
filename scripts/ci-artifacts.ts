import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  statSync,
  realpathSync,
  renameSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ciInputs } from "./ci-inputs.ts";
import { wasiTestFiles } from "./prepare-wasi-tests.ts";

const guests = ["shell-engine", "shell-runtime", "argv-py", "printenv-py"];
const programs = guests.map((name) => `${name}.wasm`).concat(["test-guest.wasm", "test-spin.wasm"]);
const cliFiles = ["shell-engine", "shell-cli", "cli-sha256.txt", "cli-source.txt"];
export const nativeArtifactFiles = cliFiles.concat(
  programs,
  ["inputs", "THIRD_PARTY_NOTICES.txt"],
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

export interface ShellArtifactIdentity {
  readonly source: string;
  readonly inputs: string;
  readonly checksumsSha256: string;
}

interface InputSnapshot {
  readonly path: string;
  readonly identity: string;
  readonly bytes: Buffer;
}

function fileIdentity(path: string) {
  const physical = realpathSync(path);
  const info = statSync(physical, { bigint: true });
  assert.ok(info.isFile(), `Expected a regular staging input: ${path}`);
  return { path: physical, identity: `${info.dev}:${info.ino}` };
}

function acceptedFileIdentities(directory: string): ReturnType<typeof fileIdentity>[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return acceptedFileIdentities(path);
    return [fileIdentity(path)];
  });
}

function snapshotInput(path: string): InputSnapshot {
  const identity = fileIdentity(path);
  return { ...identity, bytes: readFileSync(identity.path) };
}

function checksumEntries(bytes: Buffer) {
  const hashes = new Map<string, string>();
  for (const line of bytes.toString().trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_./-]+)$/.exec(line);
    assert.ok(match, "Malformed native checksum receipt");
    assert.ok(!hashes.has(match[2]), "Duplicate native checksum receipt entry");
    hashes.set(match[2], match[1]);
  }
  return hashes;
}

/** Validate immutable snapshots with the unchanged normal native receipt format. */
export function verifyShellArtifacts(directory: string, expected: ShellArtifactIdentity) {
  assert.match(expected.source, /^[a-f0-9]{40}$/);
  for (const value of [expected.inputs, expected.checksumsSha256])
    assert.match(value, /^[a-f0-9]{64}$/);
  const receipts = ["cli-source.txt", "inputs", "SHA256SUMS"].map((name) =>
    snapshotInput(resolve(directory, name)),
  );
  const [sourceReceipt, inputReceipt, checksums] = receipts;
  assert.equal(sourceReceipt.bytes.toString(), `${expected.source}\n`);
  assert.equal(inputReceipt.bytes.toString(), `${expected.inputs}\n`);
  assert.equal(
    createHash("sha256").update(checksums.bytes).digest("hex"),
    expected.checksumsSha256,
  );
  const hashes = checksumEntries(checksums.bytes);
  const assets = ["shell-runtime.wasm", "env.wasm", "THIRD_PARTY_NOTICES.txt"].map((name) => {
    const input = snapshotInput(resolve(directory, name));
    assert.equal(
      createHash("sha256").update(input.bytes).digest("hex"),
      hashes.get(name),
      `Accepted shell artifact differs: ${name}`,
    );
    return { name, ...input };
  });
  return {
    directory: realpathSync(directory),
    assets,
    inputs: receipts.concat(assets),
    protectedFiles: acceptedFileIdentities(directory),
  };
}

function resolvedOutput(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    missing.push(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  if (missing.length)
    assert.ok(statSync(ancestor).isDirectory(), `Output ancestor is not a directory: ${ancestor}`);
  return missing.reverse().reduce((parent, name) => resolve(parent, name), realpathSync(ancestor));
}

function contained(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function destinationFile(root: string, path: string) {
  const lexical = resolve(root, path);
  const entry = lstatSync(lexical, { throwIfNoEntry: false });
  assert.ok(!entry?.isSymbolicLink(), `Staging destination is a symlink: ${lexical}`);
  assert.ok(!entry || entry.isFile(), `Staging destination is not a regular file: ${lexical}`);
  const physical = resolvedOutput(lexical);
  assert.ok(contained(root, physical), `Staging destination escapes consumer root: ${lexical}`);
  return { path: physical, identity: entry ? fileIdentity(physical).identity : undefined };
}

function protectedCallerNotice(root: string, mode: "browser" | "native") {
  const path = resolve(root, "dist/THIRD_PARTY_NOTICES.txt");
  return mode === "native" && lstatSync(path, { throwIfNoEntry: false })
    ? [fileIdentity(path)]
    : [];
}

function planShellOutputs(
  destination: string,
  verified: ReturnType<typeof verifyShellArtifacts>,
  mode: "browser" | "native",
) {
  const root = resolvedOutput(destination);
  const paths =
    mode === "browser"
      ? ["public/programs/shell-engine.wasm", "dist/env.wasm", "dist/THIRD_PARTY_NOTICES.txt"]
      : [
          "dist/bash-web-shell.wasm",
          "dist/bash-web-env.wasm",
          "dist/BASH_WEB_THIRD_PARTY_NOTICES.txt",
        ];
  const outputs = verified.assets.map((asset, index) => ({
    ...destinationFile(root, paths[index]),
    bytes: asset.bytes,
  }));
  const inputs: readonly Pick<InputSnapshot, "path" | "identity">[] = verified.inputs;
  const protectedFiles = inputs.concat(verified.protectedFiles, protectedCallerNotice(root, mode));
  const outputPaths = new Set<string>();
  const outputInodes = new Set<string>();
  for (const output of outputs) {
    assert.ok(
      !contained(verified.directory, output.path),
      "Staging destination is inside accepted inputs",
    );
    assert.ok(!outputPaths.has(output.path), "Staging destinations resolve to the same path");
    assert.ok(
      !output.identity || !outputInodes.has(output.identity),
      "Staging destinations share an inode",
    );
    for (const input of protectedFiles) {
      assert.notEqual(output.path, input.path, "Staging destination overlaps a protected input");
      assert.ok(
        !output.identity || output.identity !== input.identity,
        "Staging destination shares a protected input inode",
      );
    }
    outputPaths.add(output.path);
    if (output.identity) outputInodes.add(output.identity);
  }
  return outputs;
}

function replaceStagedFile(output: { path: string; bytes: Buffer }) {
  mkdirSync(dirname(output.path), { recursive: true });
  const temporary = mkdtempSync(resolve(dirname(output.path), ".bash-web-stage-"));
  try {
    const path = resolve(temporary, "asset");
    writeFileSync(path, output.bytes, { flag: "wx" });
    renameSync(path, output.path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Preflight the complete plan, then atomically replace outputs from validated bytes. */
export function stageShellArtifacts(
  destination: string,
  directory: string,
  expected: ShellArtifactIdentity,
  mode: "browser" | "native",
) {
  const verified = verifyShellArtifacts(directory, expected);
  const outputs = planShellOutputs(destination, verified, mode);
  for (const output of outputs) replaceStagedFile(output);
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
  copy(
    resolve(root, "dist/THIRD_PARTY_NOTICES.txt"),
    resolve(directory, "THIRD_PARTY_NOTICES.txt"),
  );
  writeFileSync(resolve(directory, "inputs"), `${ciInputs("HEAD", root).native}\n`);
  writeFileSync(resolve(directory, "SHA256SUMS"), checksums(directory));
  verifyCiArtifacts(root, directory);
}

function copyNotices(root: string, directory: string) {
  copy(
    resolve(directory, "THIRD_PARTY_NOTICES.txt"),
    resolve(root, "dist/THIRD_PARTY_NOTICES.txt"),
  );
}

export function stageCiNotices(root: string, directory: string) {
  verifyCiArtifacts(root, directory);
  copyNotices(root, directory);
}

export function stageCiArtifacts(root: string, directory: string) {
  verifyCiArtifacts(root, directory);
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
  copyNotices(root, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const [command, directory, destination, revision, inputs, checksumsSha256, mode] =
    process.argv.slice(2);
  if (command === "stage-shell") {
    assert.ok(directory && destination && revision && inputs && checksumsSha256);
    assert.ok(mode === "browser" || mode === "native");
    stageShellArtifacts(
      resolve(destination),
      resolve(directory),
      { source: revision, inputs, checksumsSha256 },
      mode,
    );
  } else {
    assert.ok(
      directory && process.argv.length === 4,
      "Use pack|stage|notices <artifact directory>",
    );
    if (command === "pack") packCiArtifacts(root, resolve(directory));
    else if (command === "stage") stageCiArtifacts(root, resolve(directory));
    else if (command === "notices") stageCiNotices(root, resolve(directory));
    else throw new Error("Use pack|stage|notices <artifact directory>");
  }
}
