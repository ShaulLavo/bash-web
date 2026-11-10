import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PythonMeasurement } from "./python-measurement";

test("the actual complete measurement file and attachment are outside the compact verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "python-measurement-"));
  try {
    const result = join(root, "result.json");
    const info = new PythonMeasurement(result, "PY01");
    await mkdir(info.outputDir, { recursive: true });
    const path = info.outputPath("python-measurement-report.json");
    const body = JSON.stringify(
      {
        resources: Array.from({ length: 2650 }, (_, index) => ({
          url: `http://fixture/python-files/Lib/module-${index}.py`,
          decodedBytes: index,
        })),
        unicode: "β",
        absent: undefined,
      },
      null,
      2,
    );
    assert.ok(Buffer.byteLength(body) > 48 * 1024);
    await writeFile(path, body);
    await info.attach("python-measurement", { path, contentType: "application/json" });
    assert.equal(await readFile(path, "utf8"), body);
    const attached = JSON.parse(await readFile(`${result}.attachments.json`, "utf8"));
    assert.equal(attached.attachments[0].body, body);
    assert.equal(attached.attachments[0].caseId, "PY01");
    assert.deepEqual(info.attachments, [
      {
        name: "python-measurement",
        contentType: "application/json",
        path,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(info.attachments)) < 48 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measurement attachment cannot read an unrelated path or change the original descriptor", async () => {
  const info = new PythonMeasurement("/work/tmp/unused-python-result.json", "PY01");
  assert.throws(() => info.outputPath("../secret"), /file name/);
  await assert.rejects(
    info.attach("python-measurement", {
      path: "/unrelated",
      contentType: "application/json",
    }),
    /Unexpected/,
  );
  await assert.rejects(
    info.attach("renamed", {
      path: info.outputPath("python-measurement-report.json"),
      contentType: "application/json",
    }),
    /Unexpected/,
  );
  assert.throws(() => new PythonMeasurement("relative.json", "PY01"), /absolute/);
});
