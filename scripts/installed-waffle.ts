import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  assertPackageHostInterface,
  assertRuntimePeer,
  metadataRecord,
  parseHostInterface,
} from "./waffle-host-interface.ts";

export const installedFamilyNames = [
  "waffle-coreutils",
  "waffle-findutils",
  "waffle-grep",
  "waffle-ripgrep",
  "waffle-sed",
  "waffle-base",
  "@waffle/python",
  "waffle-git",
];

export function readMetadata(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return metadataRecord(value);
}

function packageDirectory(entry: string, name: string): string {
  let directory = dirname(realpathSync(entry));
  while (true) {
    const path = resolve(directory, "package.json");
    if (existsSync(path) && readMetadata(path).name === name) return directory;
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Cannot locate installed package ${name}`);
    directory = parent;
  }
}

function runtimeLockEntries(root: string, specifier: unknown): void {
  const packages = metadataRecord(readMetadata(resolve(root, "package-lock.json")).packages);
  const entries = Object.entries(packages).filter(([path]) =>
    /(?:^|\/)node_modules\/waffle$/.test(path),
  );
  assert.equal(entries.length, 1, "Expected exactly one npm runtime lock entry");
  assert.equal(metadataRecord(entries[0][1]).resolved, specifier, "Unselected npm runtime archive");
  const bun = readFileSync(resolve(root, "bun.lock"), "utf8");
  const matches = Array.from(bun.matchAll(/^\s*"(?:[^"\n]+\/)?waffle":\s*\["waffle@([^"\n]+)"/gm));
  assert.equal(matches.length, 1, "Expected exactly one Bun runtime lock entry");
  assert.equal(matches[0][1], specifier, "Unselected Bun runtime archive");
}

export function verifyInstalledWaffle(
  root: string,
  families: readonly string[] = installedFamilyNames,
) {
  const selected = metadataRecord(readMetadata(resolve(root, "sources.lock.json")).waffle);
  const required = parseHostInterface(selected.hostInterface, "sources.lock.json.waffle");
  const consumer = readMetadata(resolve(root, "package.json"));
  assertPackageHostInterface(consumer, required, "bash-web");
  assertRuntimePeer(consumer, "bash-web");
  assert.equal(
    metadataRecord(consumer.devDependencies).waffle,
    selected.specifier,
    "Unselected build runtime",
  );
  runtimeLockEntries(root, selected.specifier);
  const require = createRequire(resolve(root, "package.json"));
  const runtimeEntry = realpathSync(require.resolve("waffle"));
  const runtimeDirectory = packageDirectory(runtimeEntry, "waffle");
  const runtime = readMetadata(resolve(runtimeDirectory, "package.json"));
  assertPackageHostInterface(runtime, required, "installed Waffle");
  assert.equal(runtime.version, selected.version, "Installed Waffle release mismatch");
  const directories = new Map<string, string>();
  for (const name of families) {
    const directory = packageDirectory(require.resolve(name), name);
    const metadata = readMetadata(resolve(directory, "package.json"));
    assertPackageHostInterface(metadata, required, name);
    assertRuntimePeer(metadata, name);
    const familyRequire = createRequire(resolve(directory, "package.json"));
    assert.equal(
      realpathSync(familyRequire.resolve("waffle")),
      runtimeEntry,
      `${name}: duplicate physical runtime`,
    );
    directories.set(name, directory);
  }
  return { required, runtimeDirectory, runtimeEntry, directories };
}
