import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ProgramDefinition, Runtime } from "waffle";
import { installCat, UtilityConflictError } from "../src/utilities/cat";
import { installGrep } from "../src/utilities/grep";
import { installHead } from "../src/utilities/head";
import { installSort } from "../src/utilities/sort";
import { installUniq } from "../src/utilities/uniq";
import { installRg } from "../src/utilities/rg";

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
type Program = ProgramDefinition;

function fixture(context: TestContext) {
  const files = new Map<string, Uint8Array>();
  const adapters = new Set<string>();
  const programs = new Map<string, Program>();
  const fetched: string[] = [];
  const previousFetch = globalThis.fetch;
  let failFetch = false;
  let registrationFailure: Error | undefined;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    if (failFetch) return new Response(null, { status: 503 });
    return new Response(wasm);
  };
  context.after(() => {
    globalThis.fetch = previousFetch;
  });
  const runtime = {
    disposed: false,
    registerAdapter(name: string) {
      if (adapters.has(name)) throw new Error(`Adapter already registered: ${name}`);
      adapters.add(name);
      return () => adapters.delete(name);
    },
    registerProgram(path: string, program: Program) {
      assert.ok(files.has(path), "the executable entry exists before registration");
      if (registrationFailure) {
        const error = registrationFailure;
        registrationFailure = undefined;
        throw error;
      }
      if (programs.has(path)) throw new Error(`Program already registered: ${path}`);
      programs.set(path, program);
      return () => programs.delete(path);
    },
    filesystem: {
      async lookup(path: string) {
        if (files.has(path)) return { kind: "file" };
        return path === "/bin/dir" ? { kind: "dir" } : undefined;
      },
      async readFile(path: string) {
        return files.get(path);
      },
      async mkdirp() {},
      async writeFile(path: string, bytes: Uint8Array, mode: { exclusive?: boolean }) {
        assert.equal(mode.exclusive, true);
        if (files.has(path)) throw new Error("EEXIST");
        files.set(path, bytes);
      },
      async remove(path: string) {
        return files.delete(path);
      },
      async drain() {},
    },
  };
  return {
    runtime: runtime as unknown as Runtime,
    filesystem: runtime.filesystem,
    failNextRegistration(error: Error) {
      registrationFailure = error;
    },
    files,
    adapters,
    programs,
    fetched,
    failNextFetch(value: boolean) {
      failFetch = value;
    },
  };
}

test("installing one utility registers only it and loads nothing until first spawn", async (context) => {
  const state = fixture(context);
  const installation = await installCat(state.runtime, { wasmUrl: "https://cdn.test/cat.wasm" });
  assert.equal(installation.executable, "/bin/cat");
  assert.deepEqual(Array.from(state.programs.keys()), ["/bin/cat"]);
  assert.deepEqual(Array.from(state.adapters), ["bash-web:utility:cat"]);
  assert.deepEqual(state.fetched, []);
  const program = state.programs.get("/bin/cat")!;
  assert.equal(program.cooperative, true);
  assert.equal(typeof program.module, "function");
  assert.ok(typeof program.module === "function");
  const [first, second] = await Promise.all([program.module(), program.module()]);
  assert.equal(first, second, "one in-flight load is shared");
  assert.deepEqual(state.fetched, ["https://cdn.test/cat.wasm"]);
});

test("a failed program load is retried by a later spawn", async (context) => {
  const state = fixture(context);
  await installGrep(state.runtime, { wasmUrl: "https://cdn.test/grep.wasm" });
  const program = state.programs.get("/bin/grep")!;
  assert.ok(typeof program.module === "function");
  state.failNextFetch(true);
  await assert.rejects(program.module(), /fetch failed.*503/);
  state.failNextFetch(false);
  assert.ok((await program.module()) instanceof WebAssembly.Module);
  assert.equal(state.fetched.length, 2);
});

test("a caller-supplied module never fetches", async (context) => {
  const state = fixture(context);
  const module = await WebAssembly.compile(wasm);
  await installCat(state.runtime, { module: () => module });
  const program = state.programs.get("/bin/cat");
  assert.ok(program && typeof program.module === "function");
  assert.equal(await program.module(), module);
  assert.deepEqual(state.fetched, []);
});

test("an existing foreign entry is a conflict and is left untouched", async (context) => {
  const state = fixture(context);
  const foreign = new TextEncoder().encode("someone else's cat\n");
  state.files.set("/bin/cat", foreign);
  await assert.rejects(installCat(state.runtime), UtilityConflictError);
  assert.equal(state.files.get("/bin/cat"), foreign);
  assert.equal(state.programs.size + state.adapters.size, 0);
});

test("a second install on the same Runtime conflicts until the first is disposed", async (context) => {
  const state = fixture(context);
  const first = await installCat(state.runtime);
  await assert.rejects(installCat(state.runtime), /already installed on this Runtime/);
  await first.dispose();
  await first.dispose();
  assert.equal(state.files.has("/bin/cat"), false, "dispose removes its own unchanged marker");
  assert.equal(state.programs.size + state.adapters.size, 0);
  const again = await installCat(state.runtime);
  assert.equal(again.executable, "/bin/cat");
});

test("a registration conflict rolls back the created marker", async (context) => {
  const state = fixture(context);
  state.adapters.add("bash-web:utility:grep");
  await assert.rejects(installGrep(state.runtime), /Adapter already registered/);
  assert.equal(state.files.has("/bin/grep"), false);
  assert.equal(state.programs.size, 0);
  state.adapters.clear();
  await installGrep(state.runtime);
  assert.ok(state.programs.has("/bin/grep"), "a failed attempt leaves the Runtime installable");
});

test("dispose preserves entries it did not create or that changed since", async (context) => {
  const state = fixture(context);
  const first = await installCat(state.runtime);
  const marker = state.files.get("/bin/cat")!;
  await first.dispose();
  state.files.set("/bin/cat", marker);
  const adopted = await installCat(state.runtime);
  await adopted.dispose();
  assert.equal(state.files.get("/bin/cat"), marker, "an adopted marker is not owned");
  state.files.delete("/bin/cat");
  const created = await installCat(state.runtime);
  const replaced = new TextEncoder().encode("user replaced\n");
  state.files.set("/bin/cat", replaced);
  await created.dispose();
  assert.equal(state.files.get("/bin/cat"), replaced);
});

test("a directory at the executable path is a conflict", async (context) => {
  const state = fixture(context);
  const filesystem = (state.runtime as unknown as { filesystem: Record<string, unknown> })
    .filesystem;
  filesystem.lookup = async () => ({ kind: "dir" });
  await assert.rejects(installGrep(state.runtime), UtilityConflictError);
  assert.equal(state.files.size + state.programs.size + state.adapters.size, 0);
});

function pausedRollback(state: ReturnType<typeof fixture>, failure: Error) {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let drains = 0;
  state.failNextRegistration(failure);
  state.filesystem.drain = async () => {
    if (++drains !== 2) return;
    entered.resolve();
    await resume.promise;
  };
  return { entered: entered.promise, resume: resume.resolve };
}

test("rollback reserves its path until cleanup settles, then a fresh install keeps its marker", async (context) => {
  const state = fixture(context);
  const failure = new Error("registration failed");
  const pause = pausedRollback(state, failure);
  const first = installCat(state.runtime);
  const rejected = assert.rejects(first, (error) => error === failure);
  await pause.entered;
  try {
    await assert.rejects(installCat(state.runtime), UtilityConflictError);
    assert.equal(state.programs.size + state.adapters.size, 0);
  } finally {
    pause.resume();
    await rejected;
  }
  const fresh = await installCat(state.runtime);
  assert.ok(state.files.has(fresh.executable));
  assert.ok(state.programs.has(fresh.executable));
  await fresh.dispose();
});

test("failed rollback preserves both errors and releases its reservation after settlement", async (context) => {
  const state = fixture(context);
  const failure = new Error("registration failed");
  const cleanup = new Error("rollback drain failed");
  const pause = pausedRollback(state, failure);
  const drain = state.filesystem.drain;
  let drains = 0;
  state.filesystem.drain = async () => {
    await drain();
    if (++drains === 2) throw cleanup;
  };
  const first = installCat(state.runtime);
  const rejected = assert.rejects(first, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure, cleanup]);
    return true;
  });
  await pause.entered;
  try {
    await assert.rejects(installCat(state.runtime), UtilityConflictError);
  } finally {
    pause.resume();
    await rejected;
  }
  state.filesystem.drain = async () => {};
  const fresh = await installCat(state.runtime);
  assert.ok(state.files.has(fresh.executable));
  await fresh.dispose();
});

test("head installs lazily at its own path and rejects duplicate registrations", async (context) => {
  const state = fixture(context);
  const installation = await installHead(state.runtime);
  assert.equal(installation.executable, "/bin/head");
  assert.deepEqual(Array.from(state.programs.keys()), ["/bin/head"]);
  assert.deepEqual(Array.from(state.adapters), ["bash-web:utility:head"]);
  assert.equal(state.fetched.length, 0);
  await assert.rejects(installHead(state.runtime), UtilityConflictError);
  const program = state.programs.get("/bin/head");
  assert.ok(program);
  assert.equal(program.cooperative, undefined);
  assert.equal(program.module, undefined);
  assert.ok(typeof program.source === "function");
  const [first, second] = await Promise.all([program.source(), program.source()]);
  assert.equal(first, second);
  assert.deepEqual(first, wasm);
  assert.equal(state.fetched.length, 1);
  assert.ok(state.fetched[0].endsWith("/dist/head.wasm"));
  await installation.dispose();
  assert.equal(state.files.has("/bin/head"), false);
  assert.equal(state.programs.size + state.adapters.size, 0);
});

test("ordinary WASI source loaders stay lazy and retry failed loads", async (context) => {
  const state = fixture(context);
  let loads = 0;
  await installHead(state.runtime, {
    source: () => {
      if (++loads === 1) throw new Error("source unavailable");
      return wasm;
    },
  });
  assert.equal(loads, 0);
  const program = state.programs.get("/bin/head");
  assert.ok(program && typeof program.source === "function");
  const load = program.source;
  await assert.rejects(async () => load(), /source unavailable/);
  assert.deepEqual(await program.source(), wasm);
  assert.equal(loads, 2);
  assert.equal(state.fetched.length, 0);
});

test("ordinary WASI source bytes bypass fetch and compilation at install", async (context) => {
  const state = fixture(context);
  await installHead(state.runtime, { source: wasm });
  const program = state.programs.get("/bin/head");
  assert.ok(program && typeof program.source === "function");
  assert.deepEqual(await program.source(), wasm);
  assert.equal(state.fetched.length, 0);
  assert.equal(program.cooperative, undefined);
});

type WasiInstaller = (runtime: Runtime) => ReturnType<typeof installSort>;

async function assertWasiInstallation(
  context: TestContext,
  name: string,
  install: WasiInstaller,
): Promise<void> {
  const state = fixture(context);
  const installation = await install(state.runtime);
  assert.equal(installation.executable, `/bin/${name}`);
  assert.deepEqual(Array.from(state.programs.keys()), [`/bin/${name}`]);
  assert.equal(state.fetched.length, 0);
  const program = state.programs.get(installation.executable);
  assert.ok(program && typeof program.source === "function");
  assert.equal(program.module, undefined);
  assert.equal(program.cooperative, undefined);
  assert.deepEqual(await program.source(), wasm);
  assert.equal(state.fetched.length, 1);
  assert.ok(state.fetched[0].endsWith(`/dist/${name}.wasm`));
  await installation.dispose();
  assert.equal(state.programs.size + state.adapters.size + state.files.size, 0);
}

test("rg registers raw source lazily without claiming another utility", async (context) => {
  await assertWasiInstallation(context, "rg", installRg);
});

for (const [name, install] of [
  ["sort", installSort],
  ["uniq", installUniq],
] as const) {
  test(`${name} loads only its own ordinary WASI source and disposes independently`, async (context) => {
    await assertWasiInstallation(context, name, install);
  });
}
