import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface GitPin {
  repository: string;
  revision: string;
}

interface ArchivePin extends GitPin {
  archiveSha256: string;
}

interface CorpusPins {
  oils: ArchivePin;
  bashkitTerminal: ArchivePin;
  brush: GitPin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateGitPin(pin: unknown): asserts pin is GitPin {
  assert.ok(isRecord(pin));
  assert.ok(typeof pin.repository === "string");
  assert.ok(typeof pin.revision === "string");
}

function validateArchivePin(pin: unknown): asserts pin is ArchivePin {
  validateGitPin(pin);
  assert.ok(isRecord(pin));
  assert.ok(typeof pin.archiveSha256 === "string");
}

function validateCorpusPins(pins: unknown): asserts pins is CorpusPins {
  assert.ok(isRecord(pins));
  validateArchivePin(pins.oils);
  validateArchivePin(pins.bashkitTerminal);
  validateGitPin(pins.brush);
}

const root = resolve(import.meta.dirname, "..");
const sources: unknown = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
validateCorpusPins(sources);
const scratch = resolve(root, process.env.BASH_COMPAT_SCRATCH ?? ".scratch", "corpus");
const destination = resolve(root, ".sources");
await mkdir(scratch, { recursive: true });
await mkdir(destination, { recursive: true });

async function archiveSource(name: string, pin: ArchivePin, members?: readonly string[]) {
  const target = resolve(destination, name);
  const marker = resolve(target, ".revision");
  if ((await readFile(marker, "utf8").catch(() => "")).trim() === pin.revision) return target;
  const response = await fetch(
    `https://codeload.github.com/${new URL(pin.repository).pathname.slice(1)}/tar.gz/${pin.revision}`,
  );
  if (!response.ok) throw new Error(`${name} source fetch failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pin.archiveSha256)
    throw new Error(`${name} source archive checksum mismatch`);
  const archive = resolve(scratch, `${name}.tar.gz`);
  await writeFile(archive, bytes);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const prefix = `${name}-${pin.revision}`;
  const args = ["-xzf", archive, "--strip-components=1", "-C", target];
  if (members) args.push("--wildcards", ...members.map((member) => `${prefix}/${member}`));
  execFileSync("tar", args);
  await writeFile(marker, `${pin.revision}\n`);
  return target;
}

async function gitSource(name: string, pin: GitPin) {
  const target = resolve(destination, name);
  const marker = resolve(target, ".revision");
  if ((await readFile(marker, "utf8").catch(() => "")).trim() === pin.revision) return target;
  await rm(target, { recursive: true, force: true });
  execFileSync("git", ["clone", "--no-checkout", "--filter=blob:none", pin.repository, target], {
    stdio: "inherit",
  });
  execFileSync("git", ["checkout", "--detach", pin.revision], { cwd: target, stdio: "inherit" });
  await writeFile(marker, `${pin.revision}\n`);
  return target;
}

await archiveSource("oils", sources.oils, ["spec/*.test.sh", "LICENSE.txt"]);
await archiveSource("bashkit", sources.bashkitTerminal, [
  "crates/bashkit/tests/spec_cases/bash/*.test.sh",
]);
await gitSource("brush", sources.brush);
console.log("Prepared pinned shell corpus sources only; no engine was built.");
