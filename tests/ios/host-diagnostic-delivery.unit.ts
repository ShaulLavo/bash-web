import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeResult } from "waffle/testing/page-runner";
import { appendHostAttachments, finalizeHostDiagnostics } from "./host-diagnostic-delivery.ts";

const name = "browser-startup-diagnostics";
const contentType = "application/json";
const direct = { selectDescriptor: (value: unknown) => value };
const primary = "original body failure must survive";
function diagnostic(body = JSON.stringify({ unavailable: true }, null, 2)) {
  return { name, body, contentType };
}
function suite(teardown: unknown) {
  return {
    selected: ["P01"],
    exit: 1,
    results: { P01: { body: { status: "fail", error: primary }, teardown } },
  };
}
async function value(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function fixture(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "diagnostic-sink-"));
  try {
    await run(join(directory, "result.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function original(path: string, source: unknown) {
  const bytes = `\n${JSON.stringify(source, null, 2)} \n`;
  await writeFile(path, bytes);
  return bytes;
}

for (const [body, pending] of [
  [JSON.stringify({ unavailable: true }, null, 2), "snapshot unavailable"],
  ["false", "snapshot unavailable"],
  [' { "startup": { "pending": [] } }\n', "none observed"],
  [
    JSON.stringify({ startup: { pending: ["shell-fetch", "worker-start"] } }),
    "shell-fetch, worker-start",
  ],
]) {
  test(`host sink emits actual two-argument diagnostics: ${pending}`, () =>
    fixture(async (path) => {
      const returned = diagnostic(body);
      const before = await original(path, suite({ status: "pass", result: returned }));
      const calls: string[][] = [];
      assert.equal(
        await finalizeHostDiagnostics(path, 1, { ...direct, emit: (...args) => calls.push(args) }),
        1,
      );
      assert.deepEqual(calls, [
        ["Pending browser startup awaits", pending],
        ["Browser startup diagnostics", body],
      ]);
      assert.deepEqual(await value(`${path}.attachments.json`), {
        attachments: [{ caseId: "P01", ...returned }],
      });
      assert.deepEqual(await value(`${path}.diagnostic-delivery.json`), {
        originalExit: 1,
        exit: 1,
        kind: "suite",
        cases: [{ caseId: "P01", status: "delivered", emitted: 2, written: true }],
        failures: [],
      });
      assert.equal(await readFile(path, "utf8"), before);
    }));
}

test("diagnostic append preserves measurement attachment records exactly", () =>
  fixture(async (path) => {
    const measure = {
      caseId: "H02",
      name: "prompt-hook-costs",
      body: '  {\n  "samples": 50\n}\n',
      contentType,
    };
    await appendHostAttachments(path, [measure]);
    const returned = diagnostic();
    const before = await original(path, suite({ status: "pass", result: returned }));
    assert.equal(await finalizeHostDiagnostics(path, 1, { ...direct, emit() {} }), 1);
    assert.deepEqual(await value(`${path}.attachments.json`), {
      attachments: [measure, { caseId: "P01", ...returned }],
    });
    assert.equal(await readFile(path, "utf8"), before);
  }));

for (const teardown of [
  undefined,
  { status: "pass", result: null },
  { status: "fail", error: "teardown rejected" },
  { status: "timeout", settled: false },
]) {
  test(`missing or failed teardown never fabricates a snapshot: ${JSON.stringify(teardown)}`, () =>
    fixture(async (path) => {
      const before = await original(path, suite(teardown));
      const calls: string[][] = [];
      assert.equal(
        await finalizeHostDiagnostics(path, 2, { ...direct, emit: (...args) => calls.push(args) }),
        2,
      );
      assert.deepEqual(calls, []);
      await assert.rejects(readFile(`${path}.attachments.json`), { code: "ENOENT" });
      const receipt = await value(`${path}.diagnostic-delivery.json`);
      assert.match(JSON.stringify(receipt), /"status":"not-returned"/);
      assert.equal(await readFile(path, "utf8"), before);
    }));
}

for (const returned of [
  diagnostic("not JSON"),
  { ...diagnostic(), name: "wrong" },
  { ...diagnostic(), body: 42 },
  { ...diagnostic(), contentType: "text/plain" },
  diagnostic('{"startup":{"pending":[2]}}'),
]) {
  test(`malformed descriptor is secondary and nonzero: ${JSON.stringify(returned)}`, () =>
    fixture(async (path) => {
      const before = await original(path, suite({ status: "pass", result: returned }));
      assert.equal(await finalizeHostDiagnostics(path, 1, { ...direct, emit() {} }), 1);
      assert.match(
        JSON.stringify(await value(`${path}.diagnostic-delivery.json`)),
        /"status":"failed"/,
      );
      await assert.rejects(readFile(`${path}.attachments.json`), { code: "ENOENT" });
      assert.equal(await readFile(path, "utf8"), before);
    }));
}

for (const initial of [0, 1, 2]) {
  test(`attachment write rejection preserves primary result and exit ${initial}`, () =>
    fixture(async (path) => {
      const before = await original(path, suite({ status: "pass", result: diagnostic() }));
      const write: typeof writeResult = async (target, source) => {
        if (target.endsWith(".attachments.json"))
          throw new Error("controlled attachment write rejection");
        await writeResult(target, source);
      };
      assert.equal(
        await finalizeHostDiagnostics(path, initial, { ...direct, write, emit() {} }),
        initial === 0 ? 2 : initial,
      );
      assert.match(
        JSON.stringify(await value(`${path}.diagnostic-delivery.json`)),
        /controlled attachment write rejection/,
      );
      assert.equal(await readFile(path, "utf8"), before);
    }));
}

test("host console failure is secondary, recorded and nonzero", () =>
  fixture(async (path) => {
    const before = await original(path, suite({ status: "pass", result: diagnostic() }));
    assert.equal(
      await finalizeHostDiagnostics(path, 0, {
        ...direct,
        emit() {
          throw new Error("stderr refused");
        },
      }),
      2,
    );
    assert.match(JSON.stringify(await value(`${path}.diagnostic-delivery.json`)), /stderr refused/);
    assert.equal(await readFile(path, "utf8"), before);
  }));

test("receipt write rejection reports secondary failure without rewriting result", () =>
  fixture(async (path) => {
    const before = await original(path, suite({ status: "pass", result: null }));
    const calls: string[][] = [];
    assert.equal(
      await finalizeHostDiagnostics(path, 0, {
        ...direct,
        write: async () => {
          throw new Error("receipt refused");
        },
        emit: (...args) => calls.push(args),
      }),
      2,
    );
    assert.deepEqual(calls, [
      ["Host diagnostic delivery receipt failed", "Error: receipt refused"],
    ]);
    assert.equal(await readFile(path, "utf8"), before);
  }));

test("precondition results are not invented suite results", () =>
  fixture(async (path) => {
    const before = await original(path, { exit: 3, precondition: "no native resources allocated" });
    const calls: string[][] = [];
    assert.equal(
      await finalizeHostDiagnostics(path, 3, { ...direct, emit: (...args) => calls.push(args) }),
      3,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(await value(`${path}.diagnostic-delivery.json`), {
      originalExit: 3,
      exit: 3,
      kind: "precondition",
      cases: [],
      failures: [],
    });
    await assert.rejects(readFile(`${path}.attachments.json`), { code: "ENOENT" });
    assert.equal(await readFile(path, "utf8"), before);
  }));

function envelopeDescriptor(result: unknown): unknown {
  assert.ok(result && typeof result === "object" && "attachments" in result);
  assert.ok(Array.isArray(result.attachments));
  return result.attachments[0] ?? null;
}

test("explicit envelope selector receives actual persisted teardown result", () =>
  fixture(async (path) => {
    const returned = diagnostic(' {"startup":{"pending":["worker ready"]}}\n');
    const envelope = { id: "D01", afterEach: "pass", attachments: [returned] };
    const before = await original(path, suite({ status: "pass", result: envelope }));
    const selected: unknown[] = [];
    const calls: string[][] = [];
    assert.equal(
      await finalizeHostDiagnostics(path, 1, {
        selectDescriptor(result) {
          selected.push(result);
          return envelopeDescriptor(result);
        },
        emit: (...args) => calls.push(args),
      }),
      1,
    );
    assert.deepEqual(selected, [envelope]);
    assert.deepEqual(calls, [
      ["Pending browser startup awaits", "worker ready"],
      ["Browser startup diagnostics", returned.body],
    ]);
    assert.deepEqual(await value(`${path}.attachments.json`), {
      attachments: [{ caseId: "P01", ...returned }],
    });
    assert.equal(await readFile(path, "utf8"), before);
  }));

test("explicit selector refusal is secondary even for a valid direct descriptor", () =>
  fixture(async (path) => {
    const before = await original(path, suite({ status: "pass", result: diagnostic() }));
    const calls: string[][] = [];
    assert.equal(
      await finalizeHostDiagnostics(path, 0, {
        selectDescriptor() {
          throw new Error("caller refused descriptor");
        },
        emit: (...args) => calls.push(args),
      }),
      2,
    );
    assert.deepEqual(calls, []);
    assert.match(
      JSON.stringify(await value(`${path}.diagnostic-delivery.json`)),
      /caller refused descriptor/,
    );
    assert.equal(await readFile(path, "utf8"), before);
  }));

test("empty selected envelope stays not-returned without automatic shape detection", () =>
  fixture(async (path) => {
    const before = await original(path, suite({ status: "pass", result: { attachments: [] } }));
    assert.equal(
      await finalizeHostDiagnostics(path, 0, { selectDescriptor: envelopeDescriptor, emit() {} }),
      0,
    );
    assert.match(
      JSON.stringify(await value(`${path}.diagnostic-delivery.json`)),
      /"status":"not-returned"/,
    );
    await assert.rejects(readFile(`${path}.attachments.json`), { code: "ENOENT" });
    assert.equal(await readFile(path, "utf8"), before);
  }));

for (const status of ["fail", "timeout", "aborted"]) {
  test(`unconfirmed ${status} teardown never invokes the selector`, () =>
    fixture(async (path) => {
      const before = await original(path, suite({ status, result: diagnostic() }));
      let selected = false;
      assert.equal(
        await finalizeHostDiagnostics(path, 1, {
          selectDescriptor() {
            selected = true;
            throw new Error("must not select an unsettled result");
          },
          emit() {},
        }),
        1,
      );
      assert.equal(selected, false);
      assert.match(
        JSON.stringify(await value(`${path}.diagnostic-delivery.json`)),
        /"status":"not-returned"/,
      );
      assert.equal(await readFile(path, "utf8"), before);
    }));
}
