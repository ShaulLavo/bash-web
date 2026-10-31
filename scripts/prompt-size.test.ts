import assert from "node:assert/strict";
import { test } from "node:test";
import type { Metafile } from "esbuild";
import { promptSize } from "./prompt-size.ts";

function metadata(): Metafile {
  const output = (
    entryPoint?: string,
    imports: Metafile["outputs"][string]["imports"] = [],
  ): Metafile["outputs"][string] => ({
    bytes: 1,
    inputs: {},
    exports: [],
    imports,
    ...(entryPoint ? { entryPoint } : {}),
  });
  return {
    inputs: {},
    outputs: {
      "out/main.js": output("src/prompt/index.ts", [
        { path: "out/shared.js", kind: "import-statement" },
        { path: "out/config.js", kind: "dynamic-import" },
      ]),
      "out/config.js": output("src/prompt/config/file.ts", [
        { path: "out/shared.js", kind: "import-statement" },
      ]),
      "out/shared.js": output(),
    },
  };
}
const sizes = new Map([
  ["out/main.js", 300],
  ["out/config.js", 200],
  ["out/shared.js", 100],
]);

test("size graph includes static dependencies without double charging lazy payload", () => {
  assert.deepEqual(promptSize(metadata(), sizes), {
    eagerBytesGzip: 400,
    configGraphBytesGzip: 300,
    configIncrementalBytesGzip: 200,
    totalBytesGzip: 600,
    statusIncrementalBytesGzip: 0,
    objectsIncrementalBytesGzip: 0,
  });
});
test("size graph fails closed for missing roots, imports, sizes, and unaccounted outputs", () => {
  const noEntry = metadata();
  delete noEntry.outputs["out/main.js"];
  assert.throws(() => promptSize(noEntry, sizes), /exactly one output/);
  const noConfig = metadata();
  delete noConfig.outputs["out/config.js"];
  assert.throws(() => promptSize(noConfig, sizes), /exactly one output/);
  const missingDependency = metadata();
  delete missingDependency.outputs["out/shared.js"];
  assert.throws(() => promptSize(missingDependency, sizes), /Unresolved/);
  const unknown = metadata();
  unknown.outputs["orphan.js"] = { bytes: 1, inputs: {}, exports: [], imports: [] };
  assert.throws(() => promptSize(unknown, sizes), /Unaccounted/);
  assert.throws(() => promptSize(metadata(), new Map()), /Missing compressed size/);
});

test("objects graph stays lazy and shared bytes are counted once", () => {
  const meta = metadata();
  meta.outputs["out/status.js"] = {
    bytes: 1,
    inputs: {},
    exports: [],
    entryPoint: "src/prompt/sources/status.ts",
    imports: [{ path: "out/objects.js", kind: "dynamic-import" }],
  };
  meta.outputs["out/objects.js"] = {
    bytes: 1,
    inputs: { "src/prompt/sources/objects.ts": { bytesInOutput: 1 } },
    exports: [],
    entryPoint: "src/prompt/sources/objects.ts",
    imports: [{ path: "out/shared.js", kind: "import-statement" }],
  };
  meta.outputs["out/main.js"].imports.push({ path: "out/status.js", kind: "dynamic-import" });
  const measured = promptSize(
    meta,
    new Map(
      Array.from(sizes).concat([
        ["out/status.js", 40],
        ["out/objects.js", 50],
      ]),
    ),
  );
  assert.equal(measured.objectsIncrementalBytesGzip, 50);
  assert.equal(measured.totalBytesGzip, 690);
  meta.outputs["out/main.js"].imports.push({ path: "out/objects.js", kind: "import-statement" });
  assert.throws(() => promptSize(meta, sizes), /must stay out/);
});
