import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function packageVersion(value: unknown): string {
  assert.ok(isRecord(value) && typeof value.version === "string");
  return value.version;
}

test("Bun-prepared Waffle resolves and shares its real Node exports", async () => {
  const sources: unknown = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
  assert.ok(isRecord(sources));
  const expectedVersion = packageVersion(sources.waffle);
  const installed: unknown = JSON.parse(
    await readFile(resolve(root, "node_modules/waffle/package.json"), "utf8"),
  );
  assert.equal(packageVersion(installed), expectedVersion);
  const expected = await realpath(resolve(root, "node_modules/waffle/dist/index.js"));
  assert.equal(import.meta.resolve("waffle"), pathToFileURL(expected).href);
  const node = await import("waffle");
  const runtime = await import("waffle/runtime");
  assert.equal(node.createRuntime, runtime.createRuntime);
  assert.equal(node.getVfsDescriptor("fast").mode, "fast");
  assert.equal(node.getVfsDescriptor("memory").persistent, false);
  assert.throws(() => node.getVfsDescriptor("safe"), { code: "UNSUPPORTED_VFS" });
});
