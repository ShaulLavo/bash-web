import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import {
  nativeArtifactFiles,
  packCiArtifacts,
  stageCiArtifacts,
  verifyCiArtifacts,
} from "./ci-artifacts.ts";
import { ciInputs } from "./ci-inputs.ts";
import { utilityNames, writeUtilityArtifacts } from "./utility-artifacts.ts";

import { cappedWasiFixture as wasm } from "./wasi-artifact-fixture.ts";

const root = resolve(import.meta.dirname, "..");

function fixture(run: (directory: string, consumer: string) => void) {
  mkdirSync(resolve(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".build/ci-artifacts-test-"));
  const directory = resolve(scratch, "artifact");
  const consumer = resolve(scratch, "consumer");
  mkdirSync(consumer);
  try {
    for (const name of nativeArtifactFiles) {
      mkdirSync(dirname(resolve(directory, name)), { recursive: true });
      writeFileSync(resolve(directory, name), wasm);
    }
    const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    writeFileSync(resolve(directory, "cli-source.txt"), source);
    writeFileSync(resolve(directory, "inputs"), `${ciInputs("HEAD").native}\n`);
    writeUtilityArtifacts(root, directory, resolve(directory, "utility-artifacts"));
    const checksums = nativeArtifactFiles
      .map(
        (name) =>
          `${createHash("sha256")
            .update(readFileSync(resolve(directory, name)))
            .digest("hex")}  ${name}\n`,
      )
      .join("");
    writeFileSync(resolve(directory, "SHA256SUMS"), checksums);
    run(directory, consumer);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the complete exact-source artifact stages both CLIs, every guest and utility receipt", () => {
  fixture((directory, consumer) => {
    chmodSync(resolve(directory, "shell-cli"), 0o644);
    stageCiArtifacts(consumer, directory);
    for (const name of ["shell-engine", "shell-cli"])
      assert.ok(statSync(resolve(consumer, ".build/shell/release", name)).mode & 0o111);
    for (const name of ["shell-engine", "shell-runtime", "argv-py", "printenv-py"].concat(
      utilityNames,
    ))
      assert.deepEqual(
        readFileSync(resolve(consumer, `.build/shell/wasm32-wasip1/release/${name}.wasm`)),
        Buffer.from(wasm),
      );
    for (const name of ["shell-engine", "test-guest", "test-spin"].concat(utilityNames))
      assert.deepEqual(
        readFileSync(resolve(consumer, `public/programs/${name}.wasm`)),
        Buffer.from(wasm),
      );
    assert.ok(existsSync(resolve(consumer, ".build/utility-artifacts/source-sha256.txt")));
  });
});

test("staged utilities are available at package URLs before browser bundling", () => {
  fixture((directory, consumer) => {
    stageCiArtifacts(consumer, directory);
    for (const name of utilityNames)
      assert.deepEqual(
        readFileSync(resolve(consumer, `dist/${name}.wasm`)),
        readFileSync(resolve(directory, `${name}.wasm`)),
      );
  });
});

for (const name of nativeArtifactFiles) {
  test(`missing ${name} fails before consumer writes`, () => {
    fixture((directory, consumer) => {
      rmSync(resolve(directory, name));
      assert.throws(() => stageCiArtifacts(consumer, directory));
      assert.equal(existsSync(resolve(consumer, ".build/shell")), false);
    });
  });
}

for (const [name, contents, error] of [
  ["cli-source.txt", `${"0".repeat(40)}\n`, /exact source/],
  ["inputs", "changed-input\n", /inputs changed/],
  ["shell-cli", "corrupt", /checksum/],
  ["SHA256SUMS", "omitted checksums", /checksum/],
] satisfies [string, string, RegExp][]) {
  test(`${name} mismatch is rejected before staging`, () => {
    fixture((directory, consumer) => {
      writeFileSync(resolve(directory, name), contents);
      assert.throws(() => stageCiArtifacts(consumer, directory), error);
      assert.equal(existsSync(resolve(consumer, ".build/shell")), false);
    });
  });
}

test("an extra WASI executable cannot silently extend the frozen test selection", () => {
  fixture((directory) => {
    writeFileSync(resolve(directory, "wasi-tests/old-leftover.wasm"), wasm);
    assert.throws(() => verifyCiArtifacts(root, directory), /WASI artifact selection/);
  });
});

test("the real pack command produces a complete receipt that the consumer accepts", () => {
  fixture((directory, consumer) => {
    stageCiArtifacts(consumer, directory);
    const packed = resolve(consumer, ".build/ci-native");
    for (const name of nativeArtifactFiles.filter((name) => name.startsWith("wasi-tests/"))) {
      mkdirSync(dirname(resolve(packed, name)), { recursive: true });
      copyFileSync(resolve(directory, name), resolve(packed, name));
    }
    packCiArtifacts(consumer, packed);
    verifyCiArtifacts(root, packed);
  });
});

test("the TypeScript prebuilt runner rejects an old source before invoking Cargo or WASI", () => {
  fixture((directory) => {
    writeFileSync(resolve(directory, "cli-source.txt"), `${"0".repeat(40)}\n`);
    const result = spawnSync(
      process.execPath,
      ["scripts/test-shell-wasi.ts", "--prebuilt", directory],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, WASI_SDK_PATH: "/nonexistent-sdk" },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Native artifacts must match this exact source/);
    assert.doesNotMatch(result.stderr, /nonexistent-sdk|spawnSync (cargo|wasmtime)/);
  });
});
