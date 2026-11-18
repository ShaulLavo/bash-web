import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "@playwright/test";
import {
  navigateTestPage,
  navigationMatcher,
  type NavigationPage,
} from "./helpers/navigate-test-page.ts";

type Call = readonly unknown[];

function fixture(engine: string, goto: () => Promise<null>) {
  const calls = { goto: [] as Call[], route: [] as Call[], unroute: [] as Call[] };
  const browserType = { name: () => engine };
  const page: NavigationPage = {
    context: () => ({ browser: () => ({ browserType: () => browserType }) }),
    goto: (...args: Parameters<Page["goto"]>) => {
      calls.goto.push(args);
      return goto();
    },
    route: async (...args: Parameters<Page["route"]>) => {
      calls.route.push(args);
      return { dispose: async () => {}, [Symbol.asyncDispose]: async () => {} };
    },
    unroute: async (...args: Parameters<Page["unroute"]>) => {
      calls.unroute.push(args);
    },
  };
  return { page, calls };
}

test("WebKit navigation routes only its document and removes the route afterwards", async () => {
  const { page, calls } = fixture("webkit", async () => null);
  const options = { waitUntil: "load" } as const;
  await navigateTestPage(page, "/?test=1&renderer=canvas", options);
  assert.deepEqual(calls.goto, [["/?test=1&renderer=canvas", options]]);
  assert.equal(calls.route.length, 1);
  const [matches, resume, routeOptions] = calls.route[0]!;
  // An expiring route breaks context routes that continue the request (Playwright 1.64.1).
  assert.equal(routeOptions, undefined);
  assert.deepEqual(calls.unroute, [[matches, resume]]);
});

for (const failure of [
  Object.assign(new Error("page.goto: Timeout 120000ms exceeded."), { name: "TimeoutError" }),
  new Error("page.goto: net::ERR_ABORTED"),
])
  test(`the route is removed after a ${failure.name} navigation failure`, async () => {
    const { page, calls } = fixture("webkit", () => Promise.reject(failure));
    await assert.rejects(navigateTestPage(page, "/?test=1"), failure);
    const [matches, resume] = calls.route[0]!;
    assert.deepEqual(calls.unroute, [[matches, resume]]);
  });

test("a failed unroute does not hide the navigation failure", async () => {
  const failure = new Error("real navigation failure");
  const { page } = fixture("webkit", () => Promise.reject(failure));
  page.unroute = async () => {
    throw new Error("page closed during teardown");
  };
  await assert.rejects(navigateTestPage(page, "/"), failure);
});

for (const engine of ["chromium", "firefox"])
  test(`${engine} navigates without a route`, async () => {
    const { page, calls } = fixture(engine, async () => null);
    await navigateTestPage(page, "/?test=1");
    assert.deepEqual(calls.goto, [["/?test=1", undefined]]);
    assert.equal(calls.route.length, 0);
  });

test("the matcher accepts only the exact document, ignoring the fragment", () => {
  const relative = navigationMatcher("/?test=1&storage=indexeddb#x");
  assert.equal(relative(new URL("http://127.0.0.1:4198/?test=1&storage=indexeddb")), true);
  assert.equal(relative(new URL("http://127.0.0.1:4198/?test=1")), false);
  assert.equal(
    relative(new URL("http://127.0.0.1:4198/worker.js?test=1&storage=indexeddb")),
    false,
  );
  const absolute = navigationMatcher("http://127.0.0.1:4198/test-fixture");
  assert.equal(absolute(new URL("http://127.0.0.1:4198/test-fixture")), true);
  assert.equal(absolute(new URL("http://127.0.0.1:4199/test-fixture")), false);
});

test("browser specs navigate through the shared helper", () => {
  // The runtime unit runner bundles this file, so locate the specs from the repository root.
  const specs = join(process.cwd(), "tests");
  // The iOS harness runs these originals byte for byte (hash-pinned in tests/ios/*.unit.ts).
  const pinned = new Set([
    "python.spec.ts",
    "session-drain.spec.ts",
    "startup-diagnostics.spec.ts",
    "prompt-hook.spec.ts",
    "prompt-status.spec.ts",
  ]);
  const direct = readdirSync(specs).filter(
    (name) =>
      name.endsWith(".spec.ts") &&
      !pinned.has(name) &&
      /\.goto\s*\(/.test(readFileSync(join(specs, name), "utf8")),
  );
  assert.deepEqual(direct, []);
});
