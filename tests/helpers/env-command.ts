import { createRuntime, type Runtime, type ProcessService } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import { WorkerProcessClient, createWorkerProcessTransport } from "waffle/proc/worker-client";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { installEnv } from "../../src/utilities/env";
import { guestLauncher } from "../../src/runtime/worker-launcher";

type Options = { fsWorker: URL; guestWorker: URL; env: Uint8Array; probe: Uint8Array };
type Output = { fd: number; bytes: Uint8Array }[];
type State = {
  runtime: Runtime;
  descriptors: DescriptorTable;
  output: Output;
  service: ProcessService;
  supervisor: Awaited<ReturnType<ProcessService["ready"]>>;
  parent: WorkerProcessClient;
  notices: Parameters<ProcessService["runtimeMessage"]>[0][];
};

export async function commandFixture(options: Options) {
  const runtime = createRuntime({ filesystem: { workerURL: options.fsWorker, mode: "memory" } });
  const descriptors = new DescriptorTable();
  try {
    return new Commands(await initialize(runtime, descriptors, options));
  } catch (error) {
    descriptors.dispose();
    await runtime.dispose();
    throw error;
  }
}

async function initialize(
  runtime: Runtime,
  descriptors: DescriptorTable,
  options: Options,
): Promise<State> {
  for (const path of ["/bin", "/tmp/spec", "/other", "/denied"])
    await runtime.filesystem.mkdirp(path);
  await installEnv(runtime, { source: options.env, workerUrl: options.guestWorker });
  runtime.registerAdapter(
    "probe",
    guestLauncher(runtime, options.guestWorker.href, undefined, true),
  );
  await runtime.filesystem.writeFile("/bin/probe", options.probe);
  await runtime.filesystem.writeFile("/denied/probe", "denied");
  runtime.registerProgram("/bin/probe", { adapter: "probe", source: options.probe });
  await runtime.filesystem.drain();
  const service = await runtime.processes();
  const supervisor = await service.ready();
  openDescriptors(descriptors);
  const output: Output = [];
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  await service.adoptRuntimeRoot(transport, {
    output: (fd, bytes) => output.push({ fd, bytes: bytes.slice() }),
  });
  const notices: State["notices"] = [];
  const parent = new WorkerProcessClient({
    transport,
    descriptors,
    codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    postMessage: (message) => notices.push(message),
  });
  return { runtime, descriptors, output, service, supervisor, parent, notices };
}

function openDescriptors(descriptors: DescriptorTable) {
  const write = (chunks: readonly Uint8Array[]) =>
    chunks.reduce((length, bytes) => length + bytes.length, 0);
  for (const fd of [0, 1, 2])
    descriptors.openAt(
      fd,
      {
        kind: "terminal",
        read: () => 0,
        tryRead: () => 0,
        write,
        tryWrite: write,
        readiness: () => ({ readable: true, writable: true, hangup: false }),
      },
      0xffffffffn,
      0n,
    );
}

async function waitRetirement(state: State, job: number) {
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const release = state.supervisor.registerJobCleanupWake(state.parent.pid, job, wake);
  try {
    while (!state.supervisor.jobCleanupReady(state.parent.pid, job)) {
      const sequence = Atomics.load(wake, 0);
      if (state.supervisor.jobCleanupReady(state.parent.pid, job)) break;
      await Atomics.waitAsync(wake, 0, sequence).value;
    }
  } finally {
    release();
  }
}

function decode(output: Output, fd: number) {
  return new TextDecoder().decode(
    Uint8Array.from(
      output.filter((item) => item.fd === fd).flatMap((item) => Array.from(item.bytes)),
    ),
  );
}

class Commands {
  constructor(private readonly state: State) {}
  get runtime() {
    return this.state.runtime;
  }
  async flush() {
    const { notices, service, parent } = this.state;
    for (const message of notices.splice(0)) await service.runtimeMessage(message, parent.pid);
  }
  async interrupt(pid: number, signal: number) {
    const deadline = Date.now() + 10000;
    while (!(await this.runtime.filesystem.lookup("/tmp/spec/ready"))) {
      if (Date.now() > deadline) throw new Error("child did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.state.service.kill(pid, signal);
  }
  async run(
    argv: string[],
    env: Record<string, string> = { PATH: "/bin", A: "old" },
    executable = "/bin/env",
    signal?: number,
  ) {
    const { output, parent, supervisor } = this.state;
    output.length = 0;
    const pid = parent.spawn(parent.pid, {
      executable,
      argv,
      env,
      cwd: "/tmp/spec",
      job: 0,
      fds: [0, 1, 2].map((fd) => ({ child: fd, parent: fd })),
    });
    await this.flush();
    const job = parent.jobOf(pid);
    if (signal !== undefined) await this.interrupt(pid, signal);
    const outcome = await supervisor.waitForExit(parent.pid, pid);
    await waitRetirement(this.state, job);
    parent.wait(parent.pid, pid);
    if (parent.waitJob(parent.pid, job) === null) throw new Error("command job not collected");
    await this.flush();
    return {
      outcome,
      stdout: decode(output, 1),
      stderr: decode(output, 2),
      live: Array.from(supervisor.table.values()).filter((record) => record.pid !== parent.pid)
        .length,
    };
  }
  async dispose() {
    this.state.descriptors.dispose();
    await this.runtime.dispose();
  }
}
