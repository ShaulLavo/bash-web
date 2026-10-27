import { createRuntime } from "waffle";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerProcessTransport, WorkerProcessClient } from "waffle/proc/worker-client";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { DescriptorTable } from "waffle/core/descriptors";
import { installUtility } from "../../../src/utilities/install.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkPublicAdmission(runtime, parent, service, supervisor, notices, output, errors) {
  const workerUrl = new URL("/shell-worker.js", location.href);
  let sourceLoads = 0;
  const raw = await installUtility(
    runtime,
    {
      name: "process-source",
      path: "/bin/process-source",
      defaultUrl: new URL("/fixture.wasm", location.href),
      execution: "wasi",
    },
    {
      workerUrl,
      source: async () => {
        sourceLoads++;
        return new Uint8Array(await (await fetch("/fixture.wasm")).arrayBuffer());
      },
    },
  );
  const probe = await installUtility(
    runtime,
    {
      name: "launch-probe",
      path: "/bin/launch-probe",
      defaultUrl: new URL("/launch-probe.wasm", location.href),
      execution: "wasi",
    },
    { workerUrl },
  );
  assert(sourceLoads === 0, "raw source eagerly loaded");
  const launch = async (executable, env) => {
    const pid = parent.spawn(parent.pid, {
      executable,
      argv: ["custom argv0", ""],
      env,
      cwd: "/workspace",
      job: 0,
      fds: [0, 1, 2, 3, 9, 1_000_000].map((fd) => ({ child: fd, parent: fd })),
    });
    const job = parent.jobOf(pid);
    for (const message of notices.splice(0)) await service.runtimeMessage(message, parent.pid);
    const result = await supervisor.waitForExit(parent.pid, pid);
    assert(parent.wait(parent.pid, pid) !== null, "public launch not collected");
    assert(parent.waitJob(parent.pid, job) !== null, "public launch job not safe");
    return result;
  };
  try {
    const rejected = await launch(raw.executable, {});
    assert(
      rejected.kind === "start-failed" && rejected.error === "ENOEXEC" && rejected.code === 8,
      `raw runtime_proc guest unexpectedly admitted: ${JSON.stringify(rejected)}`,
    );
    const diagnostic = output
      .map((entry) => entry.text)
      .concat(errors)
      .find((error) => error.includes("reserved import namespace runtime_proc"));
    assert(diagnostic, `missing raw admission exception: ${JSON.stringify({ output, errors })}`);
    const probes = [];
    for (const env of [{}, { ONLY: "exact", PWD: "/different" }]) {
      const before = output.length;
      const result = await launch(probe.executable, env);
      assert(
        result.kind === "exited" && result.code === 0,
        `probe failed: ${JSON.stringify(result)}`,
      );
      const text = output
        .slice(before)
        .map((entry) => entry.text)
        .join("");
      const observed = JSON.parse(text.trim().replace(/^LAUNCH_PROBE:/, ""));
      assert(
        JSON.stringify(observed.argv) === JSON.stringify(["custom argv0", ""]),
        "probe argv changed",
      );
      assert(observed.cwd === "/", `unexpected bootstrap cwd: ${observed.cwd}`);
      assert(
        JSON.stringify(observed.inherited) ===
          JSON.stringify([0, 1, 2, 3, 9, 1_000_000].map((fd) => ({ child: fd, parent: fd }))),
        `launch descriptor enumeration changed: ${JSON.stringify(observed.inherited)}`,
      );
      assert(
        JSON.stringify(observed.env) === JSON.stringify({ ...env, PWD: "/workspace" }),
        `launcher environment changed differently: ${JSON.stringify(observed.env)}`,
      );
      probes.push({ supplied: { env, cwd: "/workspace" }, observed });
    }
    return { rejected, sourceLoads, diagnostic, probes };
  } finally {
    await Promise.all([raw.dispose(), probe.dispose()]);
  }
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
    const admission = await checkPublicAdmission(
      runtime,
      parent,
      service,
      supervisor,
      notices,
      output,
      errors,
    );
    output.length = 0;
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
    return { admission, abiFixture: { stdout, stderr, loads, retained }, diagnostics: errors };
  } finally {
    await runtime.dispose();
    assert(runtime.disposed, "runtime not disposed");
  }
}
