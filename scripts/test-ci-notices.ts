import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { nativeArtifactFiles, stageCiNotices } from "./ci-artifacts.ts";
import { ciInputs } from "./ci-inputs.ts";
import { wasiTestFiles } from "./prepare-wasi-tests.ts";

const root = resolve(import.meta.dirname, "..");

function put(root: string, name: string, contents: string) {
  mkdirSync(dirname(resolve(root, name)), { recursive: true });
  writeFileSync(resolve(root, name), contents);
}

function fixture(run: (scratch: string) => void) {
  mkdirSync(resolve(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".build/ci-notices-test-"));
  try {
    run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function receipt(directory: string, text: string) {
  for (const name of nativeArtifactFiles) put(directory, name, "fixture");
  put(
    directory,
    "cli-source.txt",
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
  );
  put(directory, "inputs", `${ciInputs("HEAD").native}\n`);
  put(directory, "THIRD_PARTY_NOTICES.txt", text);
  const sums = nativeArtifactFiles
    .map(
      (name) =>
        `${createHash("sha256")
          .update(readFileSync(resolve(directory, name)))
          .digest("hex")}  ${name}\n`,
    )
    .join("");
  put(directory, "SHA256SUMS", sums);
  assert.deepEqual(readdirSync(resolve(directory, "wasi-tests")).sort(), wasiTestFiles.toSorted());
}

function browserInputs(consumer: string) {
  for (const [directory, label] of [
    [".sources/ghostty-webgpu", "Ghostty"],
    ["node_modules/waffle", "Waffle"],
    ["node_modules/@fregat/hotkeys", "Hotkeys"],
    ["node_modules/remix", "Remix"],
  ]) {
    put(consumer, `${directory}/LICENSE`, `${label} license ©\n`);
    put(consumer, `${directory}/licenses/extra.txt`, `${label} extra notice\n`);
  }
  put(consumer, "public/programs/rg.NOTICES.txt", "Ripgrep license notice\n");
  put(consumer, "scripts/placeholder", "");
  copyFileSync(
    resolve(root, "scripts/browser-notices.mjs"),
    resolve(consumer, "scripts/browser-notices.mjs"),
  );
}

function aggregate(consumer: string) {
  execFileSync(process.execPath, ["scripts/browser-notices.mjs"], { cwd: consumer });
  return readFileSync(resolve(consumer, "public/THIRD_PARTY_NOTICES.txt"));
}

test("handed-off shell bytes produce identical browser notices including every added license", () => {
  fixture((scratch) => {
    const standalone = resolve(scratch, "standalone");
    const consumer = resolve(scratch, "consumer");
    const artifact = resolve(scratch, "artifact");
    const shell = "# Third-party notices\n\nexact fixture shell licenses ©\n";
    browserInputs(standalone);
    browserInputs(consumer);
    put(standalone, "dist/THIRD_PARTY_NOTICES.txt", shell);
    put(consumer, "dist/THIRD_PARTY_NOTICES.txt", "stale tracked bytes");
    receipt(artifact, shell);
    stageCiNotices(consumer, artifact);
    assert.equal(readFileSync(resolve(consumer, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"), shell);
    const actual = aggregate(consumer);
    assert.deepEqual(actual, aggregate(standalone));
    for (const label of ["Ghostty terminal", "Waffle runtime", "Hotkeys", "Remix component"])
      assert.ok(actual.includes(`## ${label} / LICENSE\n`));
    assert.equal(actual.toString().match(/\/ licenses\/extra.txt/g)?.length, 4);
  });
});

for (const failure of ["missing", "corrupt", "source", "inputs"]) {
  test(`notice-only staging rejects ${failure} before replacing even a tracked notice`, () => {
    fixture((scratch) => {
      const consumer = resolve(scratch, "consumer");
      const artifact = resolve(scratch, "artifact");
      receipt(artifact, "fresh");
      put(consumer, "dist/THIRD_PARTY_NOTICES.txt", "tracked sentinel");
      if (failure === "missing") rmSync(resolve(artifact, "THIRD_PARTY_NOTICES.txt"));
      if (failure === "corrupt") put(artifact, "THIRD_PARTY_NOTICES.txt", "stale");
      if (failure === "source") put(artifact, "cli-source.txt", `${"0".repeat(40)}\n`);
      if (failure === "inputs") put(artifact, "inputs", "wrong identity\n");
      assert.throws(() => stageCiNotices(consumer, artifact));
      assert.deepEqual(readdirSync(consumer), ["dist"]);
      assert.equal(
        readFileSync(resolve(consumer, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
        "tracked sentinel",
      );
    });
  });
}
