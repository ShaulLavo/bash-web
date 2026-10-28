import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  linkSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import {
  nativeArtifactFiles,
  packCiArtifacts,
  stageCiArtifacts,
  stageShellArtifacts,
  verifyCiArtifacts,
} from "./ci-artifacts.ts";
import { ciInputs } from "./ci-inputs.ts";

import { cappedWasiFixture as wasm } from "./wasi-artifact-fixture.ts";

const root = resolve(import.meta.dirname, "..");
const shellNotice = "# Third-party notices\n\nfixture license bytes: ©\n";

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
    writeFileSync(resolve(directory, "THIRD_PARTY_NOTICES.txt"), shellNotice);
    const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    writeFileSync(resolve(directory, "cli-source.txt"), source);
    writeFileSync(resolve(directory, "inputs"), `${ciInputs("HEAD").native}\n`);
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

test("the complete exact-source artifact stages both CLIs and every shell guest", () => {
  fixture((directory, consumer) => {
    chmodSync(resolve(directory, "shell-cli"), 0o644);
    stageCiArtifacts(consumer, directory);
    for (const name of ["shell-engine", "shell-cli"])
      assert.ok(statSync(resolve(consumer, ".build/shell/release", name)).mode & 0o111);
    for (const name of ["shell-engine", "shell-runtime", "argv-py", "printenv-py"])
      assert.deepEqual(
        readFileSync(resolve(consumer, `.build/shell/wasm32-wasip1/release/${name}.wasm`)),
        Buffer.from(wasm),
      );
    for (const name of ["shell-engine", "test-guest", "test-spin"])
      assert.deepEqual(
        readFileSync(resolve(consumer, `public/programs/${name}.wasm`)),
        Buffer.from(wasm),
      );
    assert.equal(
      readFileSync(resolve(consumer, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
      shellNotice,
    );
  });
});

for (const name of nativeArtifactFiles) {
  test(`missing ${name} fails before consumer writes`, () => {
    fixture((directory, consumer) => {
      rmSync(resolve(directory, name));
      assert.throws(() => stageCiArtifacts(consumer, directory));
      assert.deepEqual(readdirSync(consumer), []);
    });
  });
}

for (const [name, contents, error] of [
  ["cli-source.txt", `${"0".repeat(40)}\n`, /exact source/],
  ["inputs", "changed-input\n", /inputs changed/],
  ["shell-cli", "corrupt", /checksum/],
  ["THIRD_PARTY_NOTICES.txt", "stale notice", /checksum/],
  ["SHA256SUMS", "omitted checksums", /checksum/],
] satisfies [string, string, RegExp][]) {
  test(`${name} mismatch is rejected before staging`, () => {
    fixture((directory, consumer) => {
      writeFileSync(resolve(directory, name), contents);
      assert.throws(() => stageCiArtifacts(consumer, directory), error);
      assert.deepEqual(readdirSync(consumer), []);
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

test("shell notices are required alongside the unchanged native and ten WASI test files", () => {
  assert.ok(nativeArtifactFiles.includes("THIRD_PARTY_NOTICES.txt"));
  assert.equal(nativeArtifactFiles.filter((name) => name.startsWith("wasi-tests/")).length, 10);
});

function shellIdentity(directory: string) {
  return {
    source: readFileSync(resolve(directory, "cli-source.txt"), "utf8").trim(),
    inputs: readFileSync(resolve(directory, "inputs"), "utf8").trim(),
    checksumsSha256: createHash("sha256")
      .update(readFileSync(resolve(directory, "SHA256SUMS")))
      .digest("hex"),
  };
}

test("accepted shell subset stages normal browser and native paths without other guests", () => {
  fixture((directory, consumer) => {
    const identity = shellIdentity(directory);
    rmSync(resolve(directory, "shell-cli"));
    stageShellArtifacts(consumer, directory, identity, "browser");
    stageShellArtifacts(consumer, directory, identity, "native");
    for (const path of [
      "public/programs/shell-engine.wasm",
      "dist/env.wasm",
      "dist/bash-web-shell.wasm",
      "dist/bash-web-env.wasm",
    ])
      assert.deepEqual(readFileSync(resolve(consumer, path)), Buffer.from(wasm));
    assert.equal(
      readFileSync(resolve(consumer, "dist/BASH_WEB_THIRD_PARTY_NOTICES.txt"), "utf8"),
      shellNotice,
    );
  });
});

for (const name of [
  "cli-source.txt",
  "inputs",
  "SHA256SUMS",
  "shell-runtime.wasm",
  "env.wasm",
  "THIRD_PARTY_NOTICES.txt",
]) {
  test(`accepted shell subset rejects wrong ${name} before writing`, () => {
    fixture((directory, consumer) => {
      const identity = shellIdentity(directory);
      writeFileSync(resolve(directory, name), "wrong bytes");
      assert.throws(() => stageShellArtifacts(consumer, directory, identity, "browser"));
      assert.deepEqual(readdirSync(consumer), []);
    });
  });
}

function treeSnapshot(directory: string): unknown[] {
  return readdirSync(directory)
    .sort()
    .flatMap<unknown>((name) => {
      const path = resolve(directory, name);
      const info = lstatSync(path, { bigint: true });
      const identity = `${info.dev}:${info.ino}`;
      if (info.isSymbolicLink()) return [{ name, identity, link: readlinkSync(path) }];
      if (info.isDirectory()) return [{ name, identity, children: treeSnapshot(path) }];
      return [{ name, identity, bytes: readFileSync(path).toString("hex") }];
    });
}

function rejectsWithoutChanges(directory: string, consumer: string, mode: "browser" | "native") {
  const identity = shellIdentity(directory);
  const before = treeSnapshot(dirname(directory));
  let rejection: unknown;
  try {
    stageShellArtifacts(consumer, directory, identity, mode);
  } catch (error) {
    rejection = error;
  }
  assert.deepEqual(
    treeSnapshot(dirname(directory)),
    before,
    "Rejected staging changed fixture bytes or entries",
  );
  assert.ok(rejection instanceof Error, "Expected destination preflight rejection");
}

test("shell destination alias to accepted env rejects without any changes", () => {
  fixture((directory, consumer) => {
    mkdirSync(resolve(consumer, "public/programs"), { recursive: true });
    symlinkSync(
      resolve(directory, "env.wasm"),
      resolve(consumer, "public/programs/shell-engine.wasm"),
    );
    rejectsWithoutChanges(directory, consumer, "browser");
  });
});

test("redirected destination parent rejects without any changes", () => {
  fixture((directory, consumer) => {
    const outside = resolve(dirname(directory), "outside");
    mkdirSync(outside);
    writeFileSync(resolve(outside, "sentinel"), "caller outside data");
    symlinkSync(outside, resolve(consumer, "public"));
    rejectsWithoutChanges(directory, consumer, "browser");
  });
});

test("native notice destination alias rejects before copying either guest", () => {
  fixture((directory, consumer) => {
    mkdirSync(resolve(consumer, "dist"));
    const caller = resolve(consumer, "dist/THIRD_PARTY_NOTICES.txt");
    writeFileSync(caller, "native caller notices");
    symlinkSync(caller, resolve(consumer, "dist/BASH_WEB_THIRD_PARTY_NOTICES.txt"));
    rejectsWithoutChanges(directory, consumer, "native");
  });
});

for (const name of [
  "env.wasm",
  "cli-source.txt",
  "inputs",
  "SHA256SUMS",
  "utility-artifacts/source-sha256.txt",
]) {
  test(`destination hardlink to accepted ${name} rejects before any write`, () => {
    fixture((directory, consumer) => {
      mkdirSync(resolve(consumer, "public/programs"), { recursive: true });
      linkSync(resolve(directory, name), resolve(consumer, "public/programs/shell-engine.wasm"));
      rejectsWithoutChanges(directory, consumer, "browser");
    });
  });
}

test("native caller notice hardlink is protected before guest writes", () => {
  fixture((directory, consumer) => {
    mkdirSync(resolve(consumer, "dist"));
    const caller = resolve(consumer, "dist/THIRD_PARTY_NOTICES.txt");
    writeFileSync(caller, "native caller notices");
    linkSync(caller, resolve(consumer, "dist/BASH_WEB_THIRD_PARTY_NOTICES.txt"));
    rejectsWithoutChanges(directory, consumer, "native");
  });
});

test("different destinations sharing an inode reject before writes", () => {
  fixture((directory, consumer) => {
    mkdirSync(resolve(consumer, "public/programs"), { recursive: true });
    mkdirSync(resolve(consumer, "dist"));
    const shell = resolve(consumer, "public/programs/shell-engine.wasm");
    writeFileSync(shell, "old output");
    linkSync(shell, resolve(consumer, "dist/env.wasm"));
    rejectsWithoutChanges(directory, consumer, "browser");
  });
});

test("atomic replacement preserves unrelated hardlinks to an old output", () => {
  fixture((directory, consumer) => {
    mkdirSync(resolve(consumer, "dist"));
    const caller = resolve(consumer, "caller-data");
    writeFileSync(caller, "caller data");
    linkSync(caller, resolve(consumer, "dist/env.wasm"));
    stageShellArtifacts(consumer, directory, shellIdentity(directory), "browser");
    assert.equal(readFileSync(caller, "utf8"), "caller data");
    assert.deepEqual(readFileSync(resolve(consumer, "dist/env.wasm")), Buffer.from(wasm));
  });
});
