import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = "  return staleness\n}";
const replacement = `  // Full precision plus the racy-index window: coarse or equal timestamps cannot
  // prove equal content immediately after a write. Rehash these recent files.
  return staleness ||
    e.mtimeNanoseconds !== s.mtimeNanoseconds ||
    e.ctimeNanoseconds !== s.ctimeNanoseconds ||
    s.mtimeSeconds >= Math.floor(Date.now() / 1000) - 1
}`;

const sources = [
  ["index.js", "e4b1c6d807e8d7a8889385061f9d7b06e9f147c4da3f8393f98eb99f470e100e"],
  ["index.cjs", "55f1a87544a75ba5970322ec7e3dcaa6f64b0d0e9f3d1d27f609b9463a63fdb8"],
];
const browserBuffer = "import { Buffer } from 'buffer';\n";

/** One bounded upstream correctness patch, applied before bundling or running Git. */
export function patchGitSource(root = resolve(import.meta.dirname, "..")) {
  const directory = resolve(root, "node_modules/isomorphic-git");
  const manifest: unknown = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "version" in manifest);
  assert.equal(manifest.version, "1.44.5");
  const changes = sources.map(([file, expected]) => {
    const path = resolve(directory, file);
    const source = readFileSync(path, "utf8");
    const unpatched = source.includes(replacement) ? source.replace(replacement, original) : source;
    const pristine =
      file === "index.js" && unpatched.startsWith(browserBuffer)
        ? unpatched.slice(browserBuffer.length)
        : unpatched;
    assert.equal(
      createHash("sha256").update(pristine).digest("hex"),
      expected,
      `unrecognized Git source: ${file}`,
    );
    assert.equal(pristine.split(original).length, 2);
    const patched =
      (file === "index.js" ? browserBuffer : "") + pristine.replace(original, replacement);
    return { path, source, patched };
  });
  for (const { path, source, patched } of changes)
    if (source !== patched) writeFileSync(path, patched);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  patchGitSource();
