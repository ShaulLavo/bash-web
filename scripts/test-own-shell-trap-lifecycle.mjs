import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner, runRoot } from "./waffle-compat.ts";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";

const modulePath =
  process.env.BASH_WEB_TRAP_WASM ??
  resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release/shell-runtime.wasm",
  );
const options = {
  modulePath,
  tmp: "/tmp/trap-lifecycle",
  env: { LC_ALL: "C.UTF-8" },
  fixtureDirectory: dirname(modulePath),
  utilityDirectory: dirname(modulePath),
};
const oracle = JSON.parse(
  await readFile(new URL("../docs/evidence/own-shell-oracle.json", import.meta.url), "utf8"),
);
const witnesses = await readFile(
  new URL("../shell/engine/tests/trap_lifecycle.rs", import.meta.url),
  "utf8",
);
const ids = Array.from(witnesses.matchAll(/check\(\s*"([^"]+)"/g), (match) => match[1]);
assert.equal(new Set(ids).size, ids.length);
assert.ok(ids.length >= 18);

// Use the exact same frozen rows as the native witnesses, without another matrix.
for (const id of ids) {
  test(`real Waffle trap lifecycle ${id}`, { timeout: 15000 }, async () => {
    const frozen = oracle.cases.find((row) => row.id === id);
    assert.ok(frozen?.bash, id);
    const run = await createWaffleRunner(options);
    const result = await run(frozen.code);
    assert.equal(result.crash, undefined, `${id} crash`);
    assert.equal(result.status, frozen.bash.status, `${id} status`);
    assert.deepEqual(result.stdout, Buffer.from(frozen.bash.stdout, "base64"), `${id} stdout`);
    assert.equal(liveNodeWorkers(), 0, `${id} worker cleanup`);
  });
}

test(
  "real Waffle trap-visible pipelines release writers before capture EOF",
  { timeout: 15000 },
  async () => {
    const run = await createWaffleRunner(options);
    const result = await run(
      "trap 'printf err' ERR; printf payload | cat; set -o pipefail; false | cat; printf after",
    );
    assert.equal(result.crash, undefined);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, Buffer.from("payloaderrafter"));
    assert.equal(liveNodeWorkers(), 0);
  },
);

test(
  "real Waffle kill during an active handler reaps workers without EXIT",
  { timeout: 15000 },
  async () => {
    installNodeWorkers();
    const waffle = await import(new URL("../.build/node/api.mjs", import.meta.url));
    const runtime = waffle.createRuntime({
      filesystem: { workerURL: new URL("../.build/node/fs.mjs", import.meta.url), mode: "memory" },
    });
    let stop = () => {};
    const chunks = [];
    try {
      await runtime.filesystem.mkdirp(options.tmp);
      await runtime.filesystem.drain();
      const module = await WebAssembly.compile(await readFile(modulePath));
      const status = await runRoot(
        runtime,
        waffle,
        module,
        options,
        "trap 'echo BAD_EXIT' EXIT; trap 'echo ready; while :; do :; done' ERR; false",
        (_fd, bytes) => {
          chunks.push(Buffer.from(bytes));
          if (Buffer.concat(chunks).includes(Buffer.from("ready"))) stop();
        },
        (cancel) => {
          stop = cancel;
        },
      );
      assert.equal(status, 137);
      assert.equal(Buffer.concat(chunks).includes(Buffer.from("BAD_EXIT")), false);
    } finally {
      await runtime.dispose();
      await stopNodeWorkers();
    }
    assert.equal(liveNodeWorkers(), 0);
  },
);
