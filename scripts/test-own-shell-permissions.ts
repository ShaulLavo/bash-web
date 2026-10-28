import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import { familyWasmPath } from "./family-assets.ts";
import type * as Api from "./waffle-node-api.ts";
import type { Runtime } from "waffle";
import type { FilesystemClient } from "waffle/fs/client";

const waffle = (await import(
  new URL("../.build/node/api.mjs", import.meta.url).href
)) as typeof Api;
const guest = resolve(
  process.env.CARGO_TARGET_DIR ?? ".build/shell",
  "wasm32-wasip1/release/shell-runtime.wasm",
);

const testApiBundle = await build({
  stdin: {
    contents:
      'export { Wasi } from "waffle/core"; export { FilesystemClient } from "waffle/fs/client";',
    resolveDir: import.meta.dirname,
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["browser"],
  write: false,
});
const testApi = (await import(
  "data:text/javascript;base64," +
    Buffer.from(testApiBundle.outputFiles[0].contents).toString("base64")
)) as Pick<typeof import("waffle/core"), "Wasi"> &
  Pick<typeof import("waffle/fs/client"), "FilesystemClient">;

async function withRuntime(body: (runtime: Runtime, fs: FilesystemClient) => Promise<void>) {
  installNodeWorkers();
  const runtime = waffle.createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../.build/node/fs.mjs", import.meta.url) },
  });
  let client: FilesystemClient | undefined;
  try {
    await runtime.filesystem.mkdirp("/permissions");
    assert.equal(runtime.filesystem.vfs.implementation, "memory");
    assert.equal(runtime.filesystem.vfs.persistent, false);
    client = new testApi.FilesystemClient(runtime.filesystem.fork());
    await body(runtime, client);
  } finally {
    client?.dispose();
    client?.connection.port.close();
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  }
}

function handle(fs: FilesystemClient, path: string) {
  const resolved = fs.resolve(fs.preopen("/"), path.replace(/^\/+/, ""));
  assert.equal(typeof resolved, "object");
  assert.ok(typeof resolved !== "number" && resolved.node !== undefined);
  return resolved.node;
}

async function file(runtime: Runtime, fs: FilesystemClient, path: string, mode: number) {
  await runtime.filesystem.writeFile(path, "payload\n");
  assert.equal(fs.setMode(handle(fs, path), mode), 0);
}

async function shell(runtime: Runtime, script: string) {
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const status = await runRoot(
    runtime,
    waffle,
    await WebAssembly.compile(await readFile(guest)),
    {
      modulePath: guest,
      tmp: "/",
      env: { PATH: "/bin", HOME: "/", TMP: "/permissions", LC_ALL: "C", LANG: "C" },
      fixtureDirectory: "",
    },
    script,
    (fd, bytes) => (fd === 2 ? errors : output).push(Buffer.from(bytes)),
    () => {},
  );
  return {
    status,
    stdout: Buffer.concat(output).toString(),
    stderr: Buffer.concat(errors).toString(),
  };
}

const denied = (error: unknown) =>
  typeof error === "object" && error !== null && "errno" in error && error.errno === 2;

test("real Waffle modes drive shared bracket predicates and deny actual I/O", () =>
  withRuntime(permissionControls));

async function permissionControls(runtime: Runtime, fs: FilesystemClient) {
  await file(runtime, fs, "/permissions/read-denied", 0o200);
  await file(runtime, fs, "/permissions/write-denied", 0o400);
  await file(runtime, fs, "/permissions/none", 0);
  await runtime.filesystem.mkdirp("/permissions/no-search");
  await file(runtime, fs, "/permissions/no-search/child", 0o600);
  assert.equal(fs.setMode(handle(fs, "/permissions/no-search"), 0o600), 0);
  await assert.rejects(runtime.filesystem.readFile("/permissions/read-denied"), denied);
  await assert.rejects(
    runtime.filesystem.writeFile("/permissions/write-denied", "changed"),
    denied,
  );
  await assert.rejects(
    runtime.filesystem.writeFile("/permissions/no-search/new", "changed"),
    denied,
  );
  await assert.rejects(runtime.filesystem.drain(), denied);
  const checks = [
    ["-r /permissions/read-denied", 1],
    ["-w /permissions/read-denied", 0],
    ["-r /permissions/write-denied", 0],
    ["-w /permissions/write-denied", 1],
    ["-e /permissions/none", 0],
    ["-f /permissions/none", 0],
    ["-r /permissions/none", 1],
    ["-w /permissions/none", 1],
    ["-d /permissions/no-search", 0],
    ["-x /permissions/no-search", 1],
    ["-e /permissions/no-search/child", 1],
    ["-r /permissions/missing", 1],
    ["-w /permissions/missing", 1],
    ["-k /permissions", 1],
    ["-u /permissions", 2],
    ["-g /permissions", 2],
    ["-k /permissions/none", 2],
    ["-x /permissions/none", 2],
  ] as const;
  const script = checks
    .flatMap(([expression]) => [`[ ${expression} ]; echo $?`, `[[ ${expression} ]]; echo $?`])
    .join("\n");
  const result = await shell(runtime, script);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, checks.flatMap(([, status]) => [status, status]).join("\n") + "\n");
  assert.equal(result.stderr.match(/unsupported predicate/g)?.length, 4);
  const io = await shell(
    runtime,
    "IFS= read -r value < /permissions/read-denied; echo read=$?; printf changed > /permissions/write-denied; echo write=$?",
  );
  assert.equal(io.stdout, "read=1\nwrite=1\n");
  assert.equal(io.status, 0);
  assert.equal(fs.setMode(handle(fs, "/permissions/read-denied"), 0o600), 0);
  assert.equal(
    new TextDecoder().decode(await runtime.filesystem.readFile("/permissions/read-denied")),
    "payload\n",
  );
  assert.equal(
    new TextDecoder().decode(await runtime.filesystem.readFile("/permissions/write-denied")),
    "payload\n",
  );
  assert.equal(fs.setMode(handle(fs, "/permissions/no-search"), 0o1700), 0);
  assert.equal(
    (
      await shell(
        runtime,
        "[ -x /permissions/no-search ]; echo $?; [[ -k /permissions/no-search ]]; echo $?; [ -e /permissions/no-search/child ]; echo $?",
      )
    ).stdout,
    "0\n0\n0\n",
  );
}

// Original tiny guest: re-export the actual five-argument import and one-page
// memory, with an empty _start. No permission implementation is supplied here.
function permissionGuest() {
  const text = (value: string) => [value.length].concat(Array.from(Buffer.from(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
      section(2, [1].concat(text("runtime_fs"), text("path_permissions_get"), [0, 0])),
      section(3, [1, 1]),
      section(5, [1, 0, 1]),
      section(7, [3].concat(text("query"), [0, 0], text("memory"), [2, 0], text("_start"), [0, 1])),
      section(10, [1, 2, 0, 0x0b]),
    ),
  );
}

test("instantiated permission import preserves masks, metadata-only access and output on errors", () =>
  withRuntime(abiControls));

async function abiControls(runtime: Runtime, fs: FilesystemClient) {
  await file(runtime, fs, "/permissions/none", 0);
  const wasi = new testApi.Wasi({
    args: [],
    env: {},
    preopens: { "/": "/" },
    fs,
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = await WebAssembly.compile(permissionGuest());
  const instance = await WebAssembly.instantiate(module, wasi.imports(module));
  wasi.start(instance);
  const { memory, query } = instance.exports;
  assert.ok(memory instanceof WebAssembly.Memory);
  assert.equal(typeof query, "function");
  if (typeof query !== "function") throw new Error("missing query export");
  const bytes = new Uint8Array(memory.buffer);
  const path = new TextEncoder().encode("permissions/none");
  bytes.set(path, 64);
  bytes.fill(0xa5, 128, 145);
  assert.equal(query(3, 64, path.length, 0, 128), 0);
  assert.deepEqual(Array.from(new Uint32Array(memory.buffer, 128, 4)), [0, 0o600, 0, 6]);
  assert.equal(bytes[144], 0xa5, "writes exactly sixteen bytes");
  const read = fs.read.bind(fs);
  let payloadReads = 0;
  fs.read = (...args) => {
    payloadReads++;
    return read(...args);
  };
  try {
    assert.equal(query(3, 64, path.length, 0, 128), 0);
    assert.equal(payloadReads, 0);
    for (const [fd, ptr, length, flags, output, errno] of [
      [3, 64, path.length, 1, 128, 58],
      [99, 64, path.length, 0, 128, 8],
      [3, 65535, 2, 0, 128, 21],
      [3, 64, path.length, 0, 65530, 21],
      [3, 64, 0, 0, 128, 28],
    ]) {
      bytes.fill(0xa5, 128, 144);
      assert.equal(query(fd, ptr, length, flags, output), errno);
      assert.ok(bytes.slice(128, 144).every((byte) => byte === 0xa5));
    }
    bytes.set(new TextEncoder().encode("permissions/lost"), 64);
    assert.equal(query(3, 64, path.length, 0, 128), 44);
    assert.ok(bytes.slice(128, 144).every((byte) => byte === 0xa5));
    const entry = wasi.descriptors.get(3);
    assert.ok(entry);
    const rights = entry.rightsBase;
    entry.rightsBase = 0n;
    assert.equal(query(3, 64, path.length, 0, 128), 76);
    assert.ok(bytes.slice(128, 144).every((byte) => byte === 0xa5));
    entry.rightsBase = rights;
    bytes[64] = 0xff;
    assert.equal(query(3, 64, 1, 0, 128), 28);
    assert.ok(bytes.slice(128, 144).every((byte) => byte === 0xa5));
  } finally {
    fs.read = read;
    wasi.descriptors.dispose();
  }
}

test("descriptor reopen checks the inode's current access, not the source rights", () =>
  withRuntime(async (runtime, fs) => {
    await file(runtime, fs, "/permissions/reopen-denied", 0o200);
    const deniedRead = await shell(
      runtime,
      "exec 3>/permissions/reopen-denied; read -r x </dev/fd/3",
    );
    assert.notEqual(deniedRead.status, 0);
    assert.equal(deniedRead.stderr, "");
    await file(runtime, fs, "/permissions/reopen-readable", 0o600);
    const allowedRead = await shell(
      runtime,
      "exec 3>>/permissions/reopen-readable; IFS= read -r x </proc/self/fd/3; printf '%s\\n' \"$x\"",
    );
    assert.deepEqual(allowedRead, { status: 0, stdout: "payload\n", stderr: "" });
  }));

test("grep descriptor operands enforce the inode's current permissions", () =>
  withRuntime(async (runtime, fs) => {
    await waffle.installPrograms(
      runtime,
      [
        {
          name: "grep",
          programs: [
            {
              path: "/usr/bin/grep",
              aliases: ["/bin/grep"],
              source: async () => new Uint8Array(await readFile(familyWasmPath("grep"))),
            },
          ],
        },
      ],
      {
        launcher: waffle.genericProgramLauncher(
          new URL("../.build/node/preview1.mjs", import.meta.url),
        ),
      },
    );
    await file(runtime, fs, "/permissions/grep-denied", 0o200);
    const deniedRead = await shell(
      runtime,
      "grep payload /permissions/grep-denied; printf '%s\\n' \"$?\"; exec 3>/permissions/grep-denied; grep payload /dev/fd/3; printf '%s\\n' \"$?\"",
    );
    assert.equal(deniedRead.status, 0);
    assert.equal(deniedRead.stdout, "2\n2\n");
    assert.match(deniedRead.stderr, /^grep: /);
    await file(runtime, fs, "/permissions/grep-readable", 0o600);
    const allowedRead = await shell(
      runtime,
      "exec 3>>/permissions/grep-readable; grep payload /proc/self/fd/3",
    );
    assert.deepEqual(allowedRead, { status: 0, stdout: "payload\n", stderr: "" });
  }));
