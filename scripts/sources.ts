import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

interface TerminalPin {
  revision: string;
  archiveSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateTerminalPin(pin: unknown): asserts pin is TerminalPin {
  assert.ok(isRecord(pin));
  assert.ok(typeof pin.revision === "string");
  assert.ok(typeof pin.archiveSha256 === "string");
}

const root = resolve(import.meta.dirname, "..");
const lock: unknown = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
assert.ok(isRecord(lock));
const terminal: unknown = lock.terminal;
validateTerminalPin(terminal);
const destination = resolve(root, ".sources/ghostty-webgpu");
const marker = resolve(destination, ".revision");
let revision: string | undefined;
try {
  revision = (await readFile(marker, "utf8")).trim();
} catch {}
if (revision !== terminal.revision) {
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  const archive = resolve(root, ".scratch/terminal.tar.gz");
  const response = await fetch(
    `https://codeload.github.com/ShaulLavo/ghostty-webgpu/tar.gz/${terminal.revision}`,
  );
  if (!response.ok) throw new Error(`Terminal source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== terminal.archiveSha256)
    throw new Error("Terminal source archive checksum mismatch");
  await writeFile(archive, bytes);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const prefix = `ghostty-webgpu-${terminal.revision}/`;
  const files = [
    "src",
    "ghostty-vt.wasm",
    "bridge.wasm",
    "canvas-compose.wasm",
    "ghostty-vt.provenance.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "docs/integration.md",
    "docs/api.md",
    "AGENTS.md",
  ];
  execFileSync(
    "tar",
    ["-xzf", archive, "--strip-components=1", "-C", destination].concat(
      files.map((file) => prefix + file),
    ),
  );
  await writeFile(marker, terminal.revision);
  await rm(archive);
}
