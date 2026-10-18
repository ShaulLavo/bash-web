import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Runtime } from "waffle";
import { registerTestPrograms } from "./helpers/test-programs";

function fixture(context: TestContext) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: "https://bash-web.test/" },
  });
  let mutations = 0;
  let registrations = 0;
  const runtime = {
    disposed: false,
    registerAdapter() {},
    registerProgram() {
      registrations++;
    },
    filesystem: {
      async mkdirp() {
        mutations++;
      },
      async writeFile() {
        mutations++;
      },
      async drain() {},
    },
  } as unknown as Runtime;
  context.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  return { runtime, mutations: () => mutations, registrations: () => registrations };
}

test("owned test program registration cancels pending fetches before touching the filesystem", async (context) => {
  const state = fixture(context);
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;
      assert.ok(signal);
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const ready = registerTestPrograms(state.runtime, controller.signal);
  assert.equal(signals.length, 2);
  controller.abort(new Error("Owned lease disposed"));
  await assert.rejects(ready, /Owned lease disposed/);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(state.mutations(), 0);
  assert.equal(state.registrations(), 1, "only shell adapter metadata was registered");
});

test("cancelled registration cannot resume after an already admitted filesystem operation", async (context) => {
  const state = fixture(context);
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  state.runtime.filesystem.mkdirp = async () => {
    entered();
    await operation;
  };
  const ready = registerTestPrograms(state.runtime, controller.signal);
  context.after(() => finish());
  await pending;
  controller.abort(new Error("Owned lease disposed"));
  finish();
  await assert.rejects(ready, /Owned lease disposed/);
  assert.equal(state.mutations(), 0);
  assert.equal(state.registrations(), 1);
});
