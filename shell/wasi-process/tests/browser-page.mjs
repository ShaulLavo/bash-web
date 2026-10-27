import { createRuntime } from "waffle";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerProcessTransport, WorkerProcessClient } from "waffle/proc/worker-client";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { DescriptorTable } from "waffle/core/descriptors";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function execute() {
  const output = [];
  let loads = 0;
  let launches = 0;
  const errors = [];
  const runtime = createRuntime({
    filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
    processHost: (options) =>
      new BrowserProcessBroker({
        ...options,
        onError: (error) => errors.push(String(error.stack ?? error)),
      }),
  });
  try {
    const filesystem = runtime.filesystem;
    await filesystem.mkdirp("/bin");
    await filesystem.mkdirp("/denied");
    await filesystem.mkdirp("/workspace");
    await filesystem.writeFile("/workspace/probe", new TextEncoder().encode("shared filesystem"));
    await filesystem.writeFile("/bin/fixture", new Uint8Array([0]));
    await filesystem.writeFile("/denied/fixture", new Uint8Array([0]));
    await filesystem.writeFile("/bin/no-start", new Uint8Array([0]));
    runtime.registerAdapter("fixture", (context, service) => {
      launches++;
      return service.launchWorker(context, {
        workerUrl: "/worker.js",
        request: {
          module: context.module,
          args: context.request.argv,
          // Test the wire's exact environment. The delivered Shell adapter's PWD
          // overlay is a separately documented host gap, not reproduced here.
          env: context.request.env,
          interruptible: context.interruptible,
        },
      });
    });
    runtime.registerProgram("/bin/fixture", {
      adapter: "fixture",
      cooperative: true,
      module: async () => {
        loads++;
        return WebAssembly.compile(await (await fetch("/fixture.wasm")).arrayBuffer());
      },
    });
    runtime.registerProgram("/bin/no-start", {
      adapter: "fixture",
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      cooperative: true,
    });
    assert(loads === 0, "registration eagerly loaded fixture");
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const descriptors = new DescriptorTable();
    const hostWrite = (chunks) => {
      output.push({
        type: "stderr",
        text: chunks.map((bytes) => new TextDecoder().decode(bytes)).join(""),
      });
      return chunks.reduce((count, bytes) => count + bytes.length, 0);
    };
    const terminal = {
      kind: "terminal",
      read: () => 0,
      tryRead: () => 0,
      write: hostWrite,
      tryWrite: hostWrite,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    };
    for (const fd of [0, 1, 2]) descriptors.openAt(fd, { ...terminal }, 0xffffffffn, 0n);
    for (const fd of [3, 9, 1_000_000]) descriptors.inherit(fd, descriptors.get(1));
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
    });
    transport.data = { filesystem: filesystem.createIdentity() };
    await service.adoptRuntimeRoot(transport, {
      output(fd, bytes) {
        output.push({
          type: fd === 2 ? "stderr" : "stdout",
          text: new TextDecoder().decode(bytes),
        });
      },
    });
    const notices = [];
    const parent = new WorkerProcessClient({
      transport,
      descriptors,
      codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
      prepareSpawn: () => ({ data: { filesystem: filesystem.createIdentity() } }),
      postMessage: (message) => notices.push(message),
    });
    const root = parent.pid;
    const pid = parent.spawn(root, {
      executable: "/bin/fixture",
      argv: ["fixture", "driver"],
      env: {},
      cwd: "/",
      job: 0,
      fds: [0, 1, 2, 3, 9, 1_000_000].map((fd) => ({ child: fd, parent: fd })),
    });
    descriptors.dispose();
    for (const message of notices.splice(0)) await service.runtimeMessage(message, root);
    const job = parent.jobOf(pid);
    const result = await supervisor.waitForExit(root, pid);
    assert(
      result.kind === "exited" && result.code === 0,
      `driver failed: ${JSON.stringify({ result, output, errors, loads, launches })}`,
    );
    assert(parent.wait(root, pid)?.kind === "exited", "driver wait did not consume");
    assert(parent.waitJob(root, job) !== null, "driver job not safe");
    for (const message of notices.splice(0)) await service.runtimeMessage(message, root);
    const stdout = output
      .filter((entry) => entry.type === "stdout")
      .map((entry) => entry.text)
      .join("");
    const stderr = output
      .filter((entry) => entry.type === "stderr")
      .map((entry) => entry.text)
      .join("");
    for (const marker of [
      "LOOKUP_OK",
      "FD3_OK",
      "HIGH_FD_OK",
      "INSPECT_OK",
      "CLOSED_STDIO_OK",
      "DESCENDANT_OK",
      "CLEANUP_OK",
      "CONSUMER_OK",
    ]) {
      assert(stdout.includes(marker), `missing ${marker}: ${stdout}`);
    }
    assert(stderr === "", `unexpected stderr: ${stderr}`);
    assert(loads === 1, `expected one first-use module load, got ${loads}`);
    const retained = Array.from(supervisor.table.values(), (record) => ({
      pid: record.pid,
      job: record.job,
    }));
    assert(
      retained.length === 1 && retained[0].pid === root,
      `uncollected processes: ${JSON.stringify(retained)}`,
    );
    return { stdout, stderr, loads, retained, diagnostics: errors };
  } finally {
    await runtime.dispose();
    assert(runtime.disposed, "runtime not disposed");
  }
}
