import { parsePythonPayloadManifest } from "@waffle/python/payload";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparationContext, RunOptions } from "waffle/testing/page-runner";

const runtimeRoots = [
  "python-tests.html",
  "python-tests.js",
  "program-worker.js",
  "fs-worker.js",
  "shell-worker.js",
  "shell-runtime.wasm",
  "python.wasm",
  "python-stdlib.json",
];
const releasedPython = {
  interpreter: {
    bytes: 6_671_815,
    sha256: "3b8aecb219628c05e6f92e90081ecce5d3b090111d4227f173ec43eaf891cc21",
  },
  manifest: {
    bytes: 623_352,
    sha256: "98d84f8c3645e471794a7537304af0aedac881b2485907211bc4d3d1a55d8c3c",
  },
};
const payloadCount = 2_650;
const payloadBytes = 52_636_839;

type Digest = { bytes: number; sha256: string };
type InventoryRow = Digest & { url: string; contentType: string; path: string | null };
type Assets = NonNullable<RunOptions["assets"]>;

function digest(bytes: Uint8Array): Digest {
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function checkDigest(actual: Digest, expected: Digest, label: string): void {
  if (actual.bytes !== expected.bytes)
    throw new Error(`Python asset byte count mismatch: ${label}`);
  if (actual.sha256 !== expected.sha256) throw new Error(`Python asset SHA-256 mismatch: ${label}`);
}

function contentType(url: string): string {
  switch (extname(url)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

export function validatePythonAssetManifest(value: unknown) {
  const manifest = parsePythonPayloadManifest(value);
  if (!value || typeof value !== "object") throw new Error("Invalid Python asset manifest");
  if (Object.keys(value).some((key) => !["format", "cpython", "argv0", "files"].includes(key)))
    throw new Error("Unexpected Python asset manifest field");
  if (manifest.files.length !== payloadCount)
    throw new Error(`Expected all ${payloadCount} Python payload rows`);
  const urls = new Set<string>();
  for (const file of manifest.files) {
    if (urls.has(file.url)) throw new Error(`Duplicate Python payload URL: ${file.url}`);
    urls.add(file.url);
    if (
      file.url !== `python-files${file.path}` ||
      /[\\?#%]/.test(file.url) ||
      new URL(file.url, "https://python.invalid/").pathname !== `/${file.url}`
    )
      throw new Error(`Noncanonical local Python payload URL: ${file.url}`);
  }
  if (manifest.files.reduce((total, file) => total + file.bytes, 0) !== payloadBytes)
    throw new Error(`Expected all ${payloadBytes} Python payload bytes`);
  return manifest;
}

async function readAsset(root: string, url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await realpath(resolve(root, `.${url}`));
  signal.throwIfAborted();
  if (!file.startsWith(root + sep)) throw new Error(`Python asset escapes prepared root: ${url}`);
  const bytes = await readFile(file, { signal });
  signal.throwIfAborted();
  return { bytes, digest: digest(bytes) };
}

async function selectedPython(signal: AbortSignal) {
  const entry = import.meta.resolve("@waffle/python/payload");
  const root = dirname(fileURLToPath(new URL("../package.json", entry)));
  const value: unknown = JSON.parse(
    await readFile(resolve(root, "package.json"), { encoding: "utf8", signal }),
  );
  if (!value || typeof value !== "object" || !("name" in value) || !("version" in value))
    throw new Error("Missing selected Python package identity");
  if (value.name !== "@waffle/python" || value.version !== "0.0.20")
    throw new Error("Expected selected installed @waffle/python 0.0.20");
  if (!("waffleHostInterface" in value) || value.waffleHostInterface !== 2)
    throw new Error("Expected Python host interface 2");
  return { root: await realpath(resolve(root, "assets")), version: value.version };
}

async function verifySelected(
  selectedRoot: string,
  url: string,
  prepared: Awaited<ReturnType<typeof readAsset>>,
  expected: Digest,
  signal: AbortSignal,
) {
  checkDigest(prepared.digest, expected, url);
  const selected = await readAsset(selectedRoot, url, signal);
  checkDigest(selected.digest, expected, `selected @waffle/python${url}`);
  if (!prepared.bytes.equals(selected.bytes))
    throw new Error(`Prepared Python bytes differ from selected install: ${url}`);
  return { file: resolve(selectedRoot, `.${url}`), ...selected.digest };
}

export async function preparedPythonAssets(context: PreparationContext, root = resolve("dist")) {
  const { signal } = context;
  signal.throwIfAborted();
  const directory = await realpath(root);
  const selected = await selectedPython(signal);
  const manifestAsset = await readAsset(directory, "/python-stdlib.json", signal);
  const manifestSource = await verifySelected(
    selected.root,
    "/python-stdlib.json",
    manifestAsset,
    releasedPython.manifest,
    signal,
  );
  const value: unknown = JSON.parse(manifestAsset.bytes.toString("utf8"));
  const manifest = validatePythonAssetManifest(value);
  const assets: Assets = {};
  const inventory: InventoryRow[] = [];
  let interpreterSource: (Digest & { file: string }) | undefined;
  for (const name of runtimeRoots) {
    const url = `/${name}`;
    const asset =
      name === "python-stdlib.json" ? manifestAsset : await readAsset(directory, url, signal);
    if (name === "python.wasm")
      interpreterSource = await verifySelected(
        selected.root,
        url,
        asset,
        releasedPython.interpreter,
        signal,
      );
    // Bun otherwise adds a charset to application/json before Blob normalizes the type.
    assets[url] = new Blob([asset.bytes], { type: contentType(url).toUpperCase() });
    inventory.push({ url, path: null, contentType: contentType(url), ...asset.digest });
  }
  for (const file of manifest.files) {
    const url = `/${file.url}`;
    const asset = await readAsset(directory, url, signal);
    checkDigest(asset.digest, file, url);
    assets[url] = new Blob([asset.bytes], { type: contentType(url).toUpperCase() });
    inventory.push({ url, path: file.path, contentType: contentType(url), ...asset.digest });
  }
  signal.throwIfAborted();
  if (!interpreterSource) throw new Error("Missing prepared Python interpreter");
  return {
    assets,
    inventory,
    payloadBytes,
    source: {
      package: "@waffle/python",
      version: selected.version,
      interpreter: interpreterSource,
      manifest: manifestSource,
    },
  };
}
