import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { verifySedSource } from "./sed-source.ts";

const root = resolve(import.meta.dirname, "..");

test("sed source matches its receipt and reverses to the pinned upstream source", (context) => {
  verifySedSource(root);
  mkdirSync(resolve(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".build/sed-source-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const directory = resolve(scratch, "third-party/uutils-sed");
  cpSync(resolve(root, "third-party/uutils-sed"), directory, { recursive: true });
  const receipt = JSON.parse(readFileSync(resolve(directory, "provenance.json"), "utf8"));
  execFileSync("git", ["apply", "--no-index", "--reverse", "wasi.patch"], {
    cwd: directory,
  });
  for (const [path, hash] of Object.entries(receipt.upstreamFiles)) {
    const bytes = readFileSync(resolve(directory, path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, path);
  }
  assert.throws(() => verifySedSource(scratch), /compiler.rs/);
  cpSync(resolve(root, "third-party/uutils-sed/src"), resolve(directory, "src"), {
    recursive: true,
  });
  writeFileSync(resolve(directory, "src/invented.rs"), "");
  assert.throws(() => verifySedSource(scratch), /file set/);
});
