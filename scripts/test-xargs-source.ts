import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { verifyXargsSource } from "./xargs-source.ts";

const root = resolve(import.meta.dirname, "..");

test("xargs source reverses to the surveyed upstream revision and rejects drift", (context) => {
  verifyXargsSource(root);
  mkdirSync(resolve(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".build/xargs-source-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const directory = resolve(scratch, "third-party/uutils-xargs");
  cpSync(resolve(root, "third-party/uutils-xargs"), directory, { recursive: true });
  const receipt = JSON.parse(readFileSync(resolve(directory, "provenance.json"), "utf8"));
  execFileSync("git", ["apply", "--no-index", "--reverse", "wasi.patch"], { cwd: directory });
  assert.equal(
    createHash("sha256")
      .update(readFileSync(resolve(directory, "src/lib.rs")))
      .digest("hex"),
    receipt.upstreamSha256,
  );
  assert.throws(() => verifyXargsSource(scratch), /src\/lib.rs/);
  cpSync(resolve(root, "third-party/uutils-xargs/src/lib.rs"), resolve(directory, "src/lib.rs"));
  writeFileSync(resolve(directory, "src/invented.rs"), "");
  assert.throws(() => verifyXargsSource(scratch), /file set/);
});
