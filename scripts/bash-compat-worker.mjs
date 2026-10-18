// One engine per worker thread. The parent terminates a worker that exceeds the case timeout.
import { parentPort, workerData } from "node:worker_threads";
import { WASI } from "node:wasi";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const { engine, modulePath, scratch, home, tmp, env } = workerData;

async function createRunner() {
  if (engine !== "own-shell") throw new Error(`Unknown compatibility engine: ${engine}`);
  return ownShellRunner();
}

function ownShellRunner() {
  const module = new WebAssembly.Module(readFileSync(modulePath));
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const browser = {
    sleep(ms) {
      Atomics.wait(sleeper, 0, 0, ms);
      return 0;
    },
    raw_mode() {},
    columns: () => 80,
    rows: () => 24,
    read: () => 0,
    cancelled: () => 0,
  };
  return async (code) => {
    const directory = mkdtempSync(resolve(scratch, "brush-"));
    const root = resolve(directory, "root");
    for (const path of [tmp, home, "/dev", "/.compat"])
      mkdirSync(resolve(root, "." + path), { recursive: true });
    writeFileSync(resolve(root, "dev/null"), "");
    writeFileSync(resolve(root, ".compat/case.sh"), code);
    const stdin = openSync("/dev/null", "r");
    const stdout = openSync(resolve(directory, "stdout"), "w");
    const stderr = openSync(resolve(directory, "stderr"), "w");
    let status;
    let crash;
    try {
      const wasi = new WASI({
        version: "preview1",
        args: ["shell-engine", "-c", code],
        env: { ...env, PWD: tmp },
        preopens: {},
        stdin,
        stdout,
        stderr,
        returnOnExit: true,
      });
      let written = 0;
      let instance;
      const wasiImports = { ...wasi.wasiImport };
      wasiImports.fd_write = (fd, iovs, count, result) => {
        const memory = new DataView(instance.exports.memory.buffer);
        for (let index = 0; index < count; index++)
          written += memory.getUint32(iovs + index * 8 + 4, true);
        if (written > 4 * 1024 * 1024) throw new Error("compatibility output limit exceeded");
        return wasi.wasiImport.fd_write(fd, iovs, count, result);
      };
      instance = new WebAssembly.Instance(module, {
        wasi_snapshot_preview1: wasiImports,
        browser,
      });
      status = wasi.start(instance);
    } catch (error) {
      crash = String(error?.message ?? error);
    } finally {
      for (const fd of [stdin, stdout, stderr]) closeSync(fd);
    }
    const result = {
      stdout: readFileSync(resolve(directory, "stdout")),
      stderr: readFileSync(resolve(directory, "stderr")),
      status,
      crash,
    };
    rmSync(directory, { recursive: true, force: true });
    return result;
  };
}

const run = await createRunner();
parentPort.on("message", async ({ id, code }) => {
  try {
    parentPort.postMessage({ id, ...(await run(code)) });
  } catch (error) {
    parentPort.postMessage({
      id,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      crash: String(error?.message ?? error),
    });
  }
});
parentPort.postMessage({ ready: true });
