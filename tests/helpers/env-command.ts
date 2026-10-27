import { createRuntime } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import { WorkerProcessClient, createWorkerProcessTransport } from "waffle/proc/worker-client";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { installEnv } from "../../src/utilities/env";
import { guestLauncher } from "../../src/runtime/worker-launcher";

export async function commandFixture(options: {
  fsWorker: URL;
  guestWorker: URL;
  env: Uint8Array;
  probe: Uint8Array;
}) {
  const runtime = createRuntime({ filesystem: { workerURL: options.fsWorker, mode: "memory" } });
  const descriptors = new DescriptorTable();
  const output: { fd: number; bytes: Uint8Array }[] = [];
  try {
    for (const path of ["/bin", "/tmp/spec", "/other", "/denied"]) await runtime.filesystem.mkdirp(path);
    await installEnv(runtime, { source: options.env, workerUrl: options.guestWorker });
    runtime.registerAdapter("probe", guestLauncher(runtime, options.guestWorker.href, undefined, true));
    await runtime.filesystem.writeFile("/bin/probe", options.probe);
    await runtime.filesystem.writeFile("/denied/probe", "denied");
    runtime.registerProgram("/bin/probe", { adapter: "probe", source: options.probe });
    await runtime.filesystem.drain();
    const service = await runtime.processes();
    const supervisor = await service.ready();
    for (const fd of [0, 1, 2]) descriptors.openAt(fd, {
      kind: "terminal",
      read: () => 0,
      tryRead: () => 0,
      write: (chunks) => chunks.reduce((length, bytes) => length + bytes.length, 0),
      tryWrite: (chunks) => chunks.reduce((length, bytes) => length + bytes.length, 0),
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    }, 0xffffffffn, 0n);
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer,
    });
    transport.data = { filesystem: runtime.filesystem.createIdentity() };
    await service.adoptRuntimeRoot(transport, {
      output: (fd, bytes) => output.push({ fd, bytes: bytes.slice() }),
    });
    const notices: Parameters<typeof service.runtimeMessage>[0][] = [];
    const parent = new WorkerProcessClient({
      transport, descriptors,
      codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
      postMessage: (message) => notices.push(message),
    });
    const flush = async () => {
      for (const message of notices.splice(0)) await service.runtimeMessage(message, parent.pid);
    };
    const interrupt = async (pid: number, signal: number) => {
      const deadline = Date.now() + 10000;
      while (!(await runtime.filesystem.lookup("/tmp/spec/ready"))) {
        if (Date.now() > deadline) throw new Error("child did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await service.kill(pid, signal);
    };
    const run = async (argv: string[], env: Record<string, string> = { PATH: "/bin", A: "old" }, executable = "/bin/env", signal?: number) => {
      output.length = 0;
      const pid = parent.spawn(parent.pid, { executable, argv, env, cwd: "/tmp/spec", job: 0,
        fds: [0, 1, 2].map((fd) => ({ child: fd, parent: fd })),
      });
      await flush();
      const job = parent.jobOf(pid);
      if (signal !== undefined) await interrupt(pid, signal);
      const outcome = await supervisor.waitForExit(parent.pid, pid);
      parent.wait(parent.pid, pid);
      if (parent.waitJob(parent.pid, job) === null) throw new Error("command job not collected");
      await flush();
      const decode = (fd: number) => new TextDecoder().decode(Uint8Array.from(output.filter((item) => item.fd === fd).flatMap((item) => Array.from(item.bytes))));
      return { outcome, stdout: decode(1), stderr: decode(2), live: Array.from(supervisor.table.values()).filter((record) => record.pid !== parent.pid).length };
    };
    return { runtime, run, dispose: async () => { descriptors.dispose(); await runtime.dispose(); } };
  } catch (error) {
    descriptors.dispose();
    await runtime.dispose();
    throw error;
  }
}
