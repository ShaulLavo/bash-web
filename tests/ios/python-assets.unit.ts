import { beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PreparationContext, RunOptions } from "waffle/testing/page-runner";
import { preparedPythonAssets, validatePythonAssetManifest } from "./python-assets";

const preparedRoot = resolve(process.env.BASH_WEB_PYTHON_PREPARED_ROOT ?? "dist");
const roots = [
  "python-tests.html",
  "python-tests.js",
  "program-worker.js",
  "fs-worker.js",
  "shell-worker.js",
  "shell-runtime.wasm",
  "python.wasm",
  "python-stdlib.json",
];
const context: PreparationContext = { scratch: tmpdir(), signal: new AbortController().signal };
let manifest: ReturnType<typeof validatePythonAssetManifest>;
let prepared: Awaited<ReturnType<typeof preparedPythonAssets>>;

beforeAll(async () => {
  const value: unknown = JSON.parse(
    await readFile(resolve(preparedRoot, "python-stdlib.json"), "utf8"),
  );
  manifest = validatePythonAssetManifest(value);
  prepared = await preparedPythonAssets(context, preparedRoot);
}, 30_000);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedType(url: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
  };
  return types[extname(url)] ?? "application/octet-stream";
}

test("loads all eight actual prepared roots and all 2,650 released payload rows without byte changes", async () => {
  const assets: NonNullable<RunOptions["assets"]> = prepared.assets;
  const urls = roots.map((name) => `/${name}`).concat(manifest.files.map((file) => `/${file.url}`));
  assert.equal(urls.length, 2_658);
  assert.deepEqual(Object.keys(assets), urls);
  assert.deepEqual(
    prepared.inventory.map((row) => row.url),
    urls,
  );
  assert.equal(prepared.payloadBytes, 52_636_839);
  let payloadBytes = 0;
  for (const row of prepared.inventory) {
    const asset = assets[row.url];
    assert.ok(asset instanceof Blob, row.url);
    assert.equal(asset.type, expectedType(row.url), row.url);
    assert.equal(row.contentType, asset.type, row.url);
    const bytes = Buffer.from(await asset.arrayBuffer());
    assert.deepEqual(bytes, await readFile(resolve(preparedRoot, `.${row.url}`)), row.url);
    assert.equal(bytes.byteLength, row.bytes, row.url);
    assert.equal(sha256(bytes), row.sha256, row.url);
    if (row.path !== null) payloadBytes += row.bytes;
  }
  assert.equal(payloadBytes, 52_636_839);
  assert.deepEqual(
    prepared.inventory
      .filter((row) => row.path !== null)
      .map((row) => ({
        path: row.path,
        url: row.url.slice(1),
        bytes: row.bytes,
        sha256: row.sha256,
      })),
    manifest.files,
  );
}, 30_000);

test("records the selected installed .22 interpreter and manifest raw identities", async () => {
  assert.equal(prepared.source.package, "@waffle/python");
  assert.equal(prepared.source.version, "0.0.22");
  assert.equal(prepared.source.interpreter.bytes, 6_671_815);
  assert.equal(
    prepared.source.interpreter.sha256,
    "3b8aecb219628c05e6f92e90081ecce5d3b090111d4227f173ec43eaf891cc21",
  );
  assert.equal(prepared.source.manifest.bytes, 623_352);
  assert.equal(
    prepared.source.manifest.sha256,
    "98d84f8c3645e471794a7537304af0aedac881b2485907211bc4d3d1a55d8c3c",
  );
  const installedRoot = await realpath(
    resolve(dirname(fileURLToPath(import.meta.resolve("@waffle/python/payload"))), "../assets"),
  );
  const selected = [
    { name: "python.wasm", identity: prepared.source.interpreter },
    { name: "python-stdlib.json", identity: prepared.source.manifest },
  ];
  for (const { name, identity } of selected) {
    assert.equal(identity.file, resolve(installedRoot, name));
    assert.deepEqual(await readFile(identity.file), await readFile(resolve(preparedRoot, name)));
  }
});

test("rejects malformed manifest identities, row shapes and incomplete payload sets", () => {
  for (const value of [
    null,
    [],
    {},
    { ...manifest, format: 2 },
    { ...manifest, cpython: "other" },
    { ...manifest, argv0: "/python.wasm" },
    { ...manifest, extra: true },
  ])
    assert.throws(() => validatePythonAssetManifest(value));
  assert.throws(
    () => validatePythonAssetManifest({ ...manifest, files: manifest.files.slice(1) }),
    /2,650|2650/,
  );
  for (const badRow of [
    null,
    { ...manifest.files[0], bytes: -1 },
    { ...manifest.files[0], bytes: 1.5 },
    { ...manifest.files[0], sha256: "bad" },
    { ...manifest.files[0], extra: true },
  ])
    assert.throws(() =>
      validatePythonAssetManifest({ ...manifest, files: [badRow].concat(manifest.files.slice(1)) }),
    );
  const files = manifest.files.map((file) => ({ ...file }));
  files[0] = { ...files[0], bytes: files[0].bytes + 1 };
  assert.throws(() => validatePythonAssetManifest({ ...manifest, files }), /payload bytes/);
});

test("rejects noncanonical, remote, encoded, query and escaping payload URLs", () => {
  const urls = [
    "",
    "/python-files/Lib/os.py",
    "https://example.test/os.py",
    "//example.test/os.py",
    "python-files/../os.py",
    "python-files/Lib/./os.py",
    "python-files//Lib/os.py",
    "python-files/Lib/os.py?x=1",
    "python-files/Lib/os.py#hash",
    "python-files/Lib/%2e%2e/os.py",
    "python-files/Lib/os%2f.py",
    "python-files\\Lib\\os.py",
    "python-files/Lib/os.py\0",
  ];
  for (const url of urls) {
    const files = [{ ...manifest.files[0], url }].concat(manifest.files.slice(1));
    assert.throws(() => validatePythonAssetManifest({ ...manifest, files }), Error, url);
  }
  for (const path of [
    "/Lib/hash#part",
    "/Lib/query?x=1",
    "/Lib/%2e%2e/file",
    "/Lib/sp ace",
    "/Lib/control\u0001",
  ]) {
    const files = [{ ...manifest.files[0], path, url: `python-files${path}` }].concat(
      manifest.files.slice(1),
    );
    assert.throws(() => validatePythonAssetManifest({ ...manifest, files }), /Noncanonical local/);
  }
  const files = [
    { ...manifest.files[0], path: "/Lib/../outside", url: "python-files/Lib/../outside" },
  ].concat(manifest.files.slice(1));
  assert.throws(() => validatePythonAssetManifest({ ...manifest, files }), /Noncanonical/);
});

test("rejects duplicate URLs and duplicate filesystem paths without silently overwriting assets", () => {
  const files = manifest.files.map((file) => ({ ...file }));
  files[1] = { ...files[1], url: files[0].url };
  assert.throws(
    () => validatePythonAssetManifest({ ...manifest, files }),
    /Duplicate Python payload URL/,
  );
  files[1] = manifest.files[0];
  assert.throws(
    () => validatePythonAssetManifest({ ...manifest, files }),
    /Duplicate Python payload path/,
  );
});

async function withRoots(check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(resolve(tmpdir(), "bash-python-assets-"));
  try {
    for (const name of roots) await copyFile(resolve(preparedRoot, name), resolve(root, name));
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function firstPayload(root: string): Promise<string> {
  const file = manifest.files[0];
  const target = resolve(root, file.url);
  await mkdir(dirname(target), { recursive: true });
  return target;
}

test("fails closed for a missing runtime root and missing payload file", async () => {
  await withRoots(async (root) => {
    await rm(resolve(root, "fs-worker.js"));
    await assert.rejects(preparedPythonAssets(context, root), /ENOENT.*fs-worker/);
    await copyFile(resolve(preparedRoot, "fs-worker.js"), resolve(root, "fs-worker.js"));
    await assert.rejects(preparedPythonAssets(context, root), /ENOENT.*python-files/);
  });
});

test("fails closed for payload byte-count and same-length SHA-256 corruption", async () => {
  await withRoots(async (root) => {
    const target = await firstPayload(root);
    const bytes = await readFile(resolve(preparedRoot, manifest.files[0].url));
    await writeFile(target, bytes.subarray(1));
    await assert.rejects(preparedPythonAssets(context, root), /byte count mismatch.*python-files/);
    bytes[0] ^= 1;
    await writeFile(target, bytes);
    await assert.rejects(preparedPythonAssets(context, root), /SHA-256 mismatch.*python-files/);
  });
});

test("rejects prepared interpreter and manifest bytes that differ from the selected release", async () => {
  await withRoots(async (root) => {
    const interpreter = await readFile(resolve(root, "python.wasm"));
    interpreter[0] ^= 1;
    await writeFile(resolve(root, "python.wasm"), interpreter);
    await assert.rejects(preparedPythonAssets(context, root), /SHA-256 mismatch.*python.wasm/);
    await writeFile(resolve(root, "python-stdlib.json"), "{invalid");
    await assert.rejects(
      preparedPythonAssets(context, root),
      /byte count mismatch.*python-stdlib.json/,
    );
  });
});

test("rejects payload symlinks escaping the prepared root", async () => {
  await withRoots(async (root) => {
    await symlink(resolve(preparedRoot, manifest.files[0].url), await firstPayload(root));
    await assert.rejects(
      preparedPythonAssets(context, root),
      /escapes prepared root.*python-files/,
    );
  });
});

test("honors abort before access and during asynchronous preparation without returning partial assets", async () => {
  const before = new AbortController();
  const reason = new Error("Python asset preparation cancelled");
  before.abort(reason);
  await assert.rejects(
    preparedPythonAssets({ ...context, signal: before.signal }, "/missing-python-root"),
    (error) => error === reason,
  );
  const during = new AbortController();
  const pending = preparedPythonAssets({ ...context, signal: during.signal }, preparedRoot);
  during.abort(reason);
  await assert.rejects(
    pending,
    (error) => error === reason || (error instanceof Error && error.name === "AbortError"),
  );
});
