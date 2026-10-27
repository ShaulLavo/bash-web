import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { pythonArgv0, pythonCases, pythonVersion } from "./helpers/python-cases.ts";
import type {} from "../scripts/measure-python.ts";

function payloadFiles(input: unknown): { path: string; bytes: number }[] {
  if (!input || typeof input !== "object" || !("files" in input) || !Array.isArray(input.files))
    throw new Error("Python manifest has no file list");
  const files: readonly unknown[] = input.files;
  return files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      !("path" in file) ||
      typeof file.path !== "string" ||
      !("bytes" in file) ||
      typeof file.bytes !== "number"
    )
      throw new Error("Python manifest file has no path/byte count");
    return { path: file.path, bytes: file.bytes };
  });
}

function isPythonAsset(url: string) {
  const path = new URL(url).pathname;
  return (
    path === "/python.wasm" || path === "/python-stdlib.json" || path.startsWith("/python-files/")
  );
}

test("real CPython on Waffle loads once, runs scripts, disposes and leaves its borrowed runtime usable", async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isPythonAsset(request.url())) requests.push(new URL(request.url()).pathname);
  });
  await page.goto("/python-tests.html");
  await page.waitForFunction(() => Boolean(window.pythonAcceptance));
  try {
    const installed = await page.evaluate(() => window.pythonAcceptance.open());
    expect(installed.payloadAbsent).toBe(true);
    expect(installed.admissions).toEqual([]);
    expect(installed.after.compiles).toEqual([]);
    expect(requests).toEqual([]);
    expect(page.workers().map((worker) => new URL(worker.url()).pathname)).toEqual([
      "/fs-worker.js",
    ]);
    const baselineWorkers = page.workers().length;
    const cold = await page.evaluate(() =>
      window.pythonAcceptance.run({ args: ["--version"], stdin: "" }),
    );
    expect(cold.status, cold.stderr).toBe(0);
    expect(cold.stdout).toBe(pythonVersion);
    expect(cold.stderr).toBe("");
    await expect.poll(() => page.workers().length).toBe(baselineWorkers);
    const loaded = requests.slice();
    expect(loaded.filter((path) => path === "/python.wasm")).toHaveLength(1);
    expect(loaded.filter((path) => path === "/python-stdlib.json")).toHaveLength(1);
    expect(new Set(loaded).size).toBe(loaded.length);
    const cwdDiagnostic = await page.evaluate(() =>
      window.pythonAcceptance.run({
        args: [
          "-c",
          'import os; print(os.getcwd()); print(os.environ["PWD"]); os.chdir(os.environ["PWD"]); print(os.getcwd())',
        ],
        stdin: "",
      }),
    );
    const warm: { name: string; milliseconds: number }[] = [];
    for (const example of pythonCases) {
      const result = await page.evaluate((value) => window.pythonAcceptance.run(value), example);
      expect.soft(result.status, `${example.name}: ${result.stderr}`).toBe(example.status);
      expect.soft(result.stdout, example.name).toBe(example.stdout);
      expect.soft(result.stderr, example.name).toBe(example.stderr);
      warm.push({ name: example.name, milliseconds: result.milliseconds });
    }
    const discovery = await page.evaluate(() =>
      window.pythonAcceptance.run({
        args: [
          "-c",
          "import json, sys, sysconfig; print(json.dumps([sys.executable, sys.platform, sysconfig.get_platform(), '/Lib' in sys.path, any(p.endswith('build/lib.wasi-wasm32-3.15') for p in sys.path)]))",
        ],
        stdin: "",
      }),
    );
    expect(discovery.status, discovery.stderr).toBe(0);
    expect(JSON.parse(discovery.stdout)).toEqual([
      pythonArgv0,
      "wasi",
      "wasi-0.0.0-wasm32",
      true,
      true,
    ]);
    expect(requests).toEqual(loaded);
    const repeated: number[] = [];
    for (let index = 0; index < 5; index++) {
      const result = await page.evaluate(() =>
        window.pythonAcceptance.run({ args: ["--version"], stdin: "" }),
      );
      expect(result.stdout).toBe(pythonVersion);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      repeated.push(result.milliseconds);
    }
    expect(requests).toEqual(loaded);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers);
    const measurement = await page.evaluate(() => window.pythonAcceptance.measurement());
    const wasm = await readFile(new URL("../dist/python.wasm", import.meta.url));
    const manifestBytes = await readFile(new URL("../dist/python-stdlib.json", import.meta.url));
    const payload = measurement.resources.filter((resource) =>
      new URL(resource.url).pathname.startsWith("/python-files/"),
    );
    const files = payloadFiles(JSON.parse(manifestBytes.toString()));
    expect(payload.length).toBe(files.length);
    expect(payload.reduce((sum, resource) => sum + resource.decodedBytes, 0)).toBe(
      files.reduce((sum, file) => sum + file.bytes, 0),
    );
    await testInfo.attach("python-measurement", {
      contentType: "application/json",
      body: JSON.stringify(
        {
          interpreter: {
            bytes: wasm.length,
            sha256: createHash("sha256").update(wasm).digest("hex"),
          },
          manifest: {
            bytes: manifestBytes.length,
            sha256: createHash("sha256").update(manifestBytes).digest("hex"),
          },
          payload: {
            files: payload.length,
            bytes: payload.reduce((sum, resource) => sum + resource.decodedBytes, 0),
          },
          coldFirstUseMilliseconds: cold.milliseconds,
          cwdDiagnostic,
          warmCaseMilliseconds: warm,
          warmVersionMilliseconds: repeated,
          scope:
            "Shell startup through Python completion and terminal drain; cold includes asset fetch, verification, VFS population/drain and Waffle compilation. Compile events include shell and guest and preserve input byte lengths. Population and drain are included in the cold total, without separate spans because the runtime filesystem facade is immutable.",
          ...measurement,
        },
        null,
        2,
      ),
    });
    const disposed = await page.evaluate(() => window.pythonAcceptance.disposeUtility());
    expect(disposed.markerRemoved).toBe(true);
    expect(disposed.payloadRemoved).toBe(true);
    expect(disposed.callerFile).toBe("caller data");
    expect(disposed.disposed).toBe(false);
    expect(disposed.recovery.status).toBe(0);
    expect(disposed.recovery.stdout).toBe("borrowed runtime alive\n");
    expect(disposed.missing.status).toBe(127);
    expect(requests).toEqual(loaded);
  } finally {
    await page.evaluate(() => window.pythonAcceptance.close());
  }
  await expect.poll(() => page.workers().length).toBe(0);
});

test("disposing Python before first use fetches no payload and stops no caller runtime", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isPythonAsset(request.url())) requests.push(request.url());
  });
  await page.goto("/python-tests.html");
  await page.waitForFunction(() => Boolean(window.pythonAcceptance));
  try {
    await page.evaluate(() => window.pythonAcceptance.open());
    const result = await page.evaluate(() =>
      window.pythonAcceptance.runScript('printf "before first use\\n"'),
    );
    expect(result.stdout).toBe("before first use\n");
    expect(result.status).toBe(0);
    expect(requests).toEqual([]);
    const disposed = await page.evaluate(() => window.pythonAcceptance.disposeUnused());
    expect(disposed.markerRemoved).toBe(true);
    expect(disposed.payloadAbsent).toBe(true);
    expect(disposed.disposed).toBe(false);
    expect(disposed.recovery.status).toBe(0);
    expect(disposed.recovery.stdout).toBe("after unused disposal\n");
  } finally {
    await page.evaluate(() => window.pythonAcceptance.close());
  }
  expect(requests).toEqual([]);
  await expect.poll(() => page.workers().length).toBe(0);
});
