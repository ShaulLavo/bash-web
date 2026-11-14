import type { Runtime } from "waffle";
import { setImmediate } from "node:timers/promises";
import { DescriptorTable, type Stream } from "waffle/core/descriptors";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "waffle/proc/worker-client";

type Service = Awaited<ReturnType<Runtime["processes"]>>;
type Supervisor = Awaited<ReturnType<Service["ready"]>>;

async function cleanupJobs(
  service: Service,
  supervisor: Supervisor,
  parent: number,
  pid: number,
  job: number,
) {
  const jobs = new Set([job]);
  for (const record of supervisor.table.values()) {
    if (record.parentPid === pid) jobs.add(record.job);
  }
  for (const owned of jobs) {
    await service.killJob(owned, 9);
    while (!supervisor.jobCleanupReady(parent, owned)) await setImmediate();
    supervisor.reapJob(parent, owned);
  }
}

function callerDescriptors(output: string[]) {
  const descriptors = new DescriptorTable();
  const decoder = new TextDecoder();
  const write = (chunks: readonly Uint8Array[]) => {
    let size = 0;
    for (const chunk of chunks) {
      output.push(decoder.decode(chunk));
      size += chunk.length;
    }
    return size;
  };
  const terminal: Stream = {
    kind: "terminal",
    read: () => 0,
    tryRead: () => 0,
    write,
    tryWrite: write,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  const rights = 2n | 64n | (1n << 27n);
  for (const fd of [0, 1, 2]) descriptors.openAt(fd, terminal, rights, 0n);
  return descriptors;
}

/** Adopt a test caller so installed guests report tagged child outcomes. */
export async function createSignalParent(runtime: Runtime) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const output: string[] = [];
  const descriptors = callerDescriptors(output);
  try {
    await service.adoptRuntimeRoot(transport, {
      memory: [],
      output: (_fd, bytes) => output.push(new TextDecoder().decode(bytes)),
    });
  } catch (error) {
    descriptors.dispose();
    throw error;
  }
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    postMessage: (message) => notices.push(message),
  });
  const drain = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, transport.pid);
  };
  const supervisor = await service.ready();
  return {
    output,
    dispose: () => descriptors.dispose(),
    async spawn(source: string) {
      const pid = client.spawn(transport.pid, {
        executable: "/bin/bash",
        argv: ["/bin/bash", "-c", source],
        env: {},
        cwd: "/",
        job: -1,
        fds: [0, 1, 2].map((fd) => ({ parent: fd, child: fd })),
      });
      await drain();
      const job = supervisor.jobOf(pid);
      await supervisor.start(pid);
      return {
        pid,
        kill: () => service.kill(pid, 9),
        cleanup: () => cleanupJobs(service, supervisor, transport.pid, pid, job),
        exit: supervisor.waitForExit(transport.pid, pid).then(async (outcome) => {
          client.wait(transport.pid, pid);
          await drain();
          return outcome;
        }),
      };
    },
  };
}
