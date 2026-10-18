// Adapted from brush-web src/runtime/browser-runtime.ts at a2a4e96.
// Root launch/outcome fencing originally follows bun-wasm web/src/runner.ts at
// 8d3d416aa9cb23718ed3487a33d0b06e8e373672. This adapter no longer creates an FS,
// broker or supervisor: the supplied Waffle Runtime is their sole page owner.
import type { ProcessService, Runtime } from "waffle";
import { markStartup, type StartupObserver } from "./startup-diagnostics";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { waitStatus } from "waffle/proc/wait-status";
import {
  createWorkerProcessTransport,
  workerProcessSlots,
  workerProcessState,
} from "waffle/proc/worker-client";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";
import { SharedBridge, control } from "../bridge";
import type { RuntimeExit, RuntimeProcess, ShellOptions } from "../shell";
import { observeProcessMessage, observeRoot, observeSupervisor } from "./diagnostics";
import { processDirectoryCapacity } from "./limits";
import {
  attachTerminal,
  createTerminalAdmission,
  quiesceTerminal,
  revokeTerminal,
} from "./terminal-admission";
import { launchTerminalWorker, waitForShellWorkers } from "./worker-launcher";
import type { ShellWorkerRequest } from "./worker";

const executable = "/programs/shell-engine.wasm";
interface Registration {
  wasmUrl: string;
  workerUrl: string;
  module(observer?: StartupObserver): Promise<{ module: WebAssembly.Module; size: number }>;
  initialize(observer?: StartupObserver): Promise<void>;
}
const registrations = new WeakMap<Runtime, Registration>();
/** Internal adapter admission for embeddings/tests; does not launch a root or load assets. */
export function registerShell(runtime: Runtime, options: ShellOptions): Registration {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const base = globalThis.document?.baseURI ?? import.meta.url;
  const wasmUrl = new URL(options.wasmUrl ?? "/programs/shell-engine.wasm", base).href;
  // This is a bundled JavaScript asset, not raw TypeScript disguised as a Worker URL.
  // Package preparation emits it; embeddings may supply their own emitted worker URL.
  const workerUrl = new URL(
    options.workerUrl ?? new URL("../../dist/shell-worker.js", import.meta.url),
    base,
  ).href;
  const existing = registrations.get(runtime);
  if (existing) {
    if (existing.wasmUrl !== wasmUrl || existing.workerUrl !== workerUrl)
      throw new Error("Shell adapters on one Runtime must use the same worker and guest URLs");
    return existing;
  }
  const registration = createRegistration(runtime, wasmUrl, workerUrl);
  registrations.set(runtime, registration);
  return registration;
}

function createRegistration(runtime: Runtime, wasmUrl: string, workerUrl: string): Registration {
  // Share successful loads and in-flight attempts, but let a later explicit caller
  // try again after failure. An individual facade never retries its own startup.
  let loaded: Promise<{ module: WebAssembly.Module; size: number }> | undefined;
  const module = (observer?: StartupObserver) => {
    if (!loaded) {
      const attempt = (async () => {
        markStartup(observer, "shell-wasm-fetch-requested");
        const response = await fetch(wasmUrl);
        markStartup(observer, "shell-wasm-fetch-resolved");
        if (!response.ok) throw new Error(`Shell executable fetch failed (${response.status})`);
        markStartup(observer, "shell-wasm-body-requested");
        const bytes = await response.arrayBuffer();
        markStartup(observer, "shell-wasm-body-resolved");
        markStartup(observer, "shell-wasm-compile-requested");
        const module = await WebAssembly.compile(bytes);
        markStartup(observer, "shell-wasm-compile-resolved");
        return { module, size: bytes.byteLength };
      })();
      loaded = attempt;
      void attempt.catch(() => {
        if (loaded === attempt) loaded = undefined;
      });
    }
    return loaded;
  };
  let removeAdapter: (() => void) | undefined;
  let removeProgram: (() => void) | undefined;
  try {
    removeAdapter = runtime.registerAdapter("bash-web:preview1", (context, service) =>
      launchTerminalWorker<ShellWorkerRequest>(runtime, service, context, {
        workerUrl,
        request: {
          module: context.module,
          args: context.request.argv,
          env: { ...context.request.env, PWD: context.request.cwd },
          interruptible: context.interruptible,
          memoryUsage: new SharedArrayBuffer(8),
        },
        wake() {},
      }),
    );
    // This package's own cooperative Rust guest checks the runtime signal ABI. Foreign
    // programs are registered by their packages, using the runtime's admission rules.
    removeProgram = runtime.registerProgram(executable, {
      adapter: "bash-web:preview1",
      module: () => module().then((value) => value.module),
      cooperative: true,
    });
  } catch (error) {
    removeProgram?.();
    removeAdapter?.();
    throw error;
  }
  let initialized: Promise<void> | undefined;
  return {
    wasmUrl,
    workerUrl,
    module,
    initialize(observer) {
      if (initialized) return initialized;
      const attempt = (async () => {
        for (const [name, directory] of [
          ["home", "/home/guest"],
          ["tmp", "/tmp"],
          ["bin", "/bin"],
          ["programs", "/programs"],
        ] as const) {
          markStartup(observer, `shell-${name}-mkdir-requested`);
          await runtime.filesystem.mkdirp(directory);
          markStartup(observer, `shell-${name}-mkdir-resolved`);
        }
        markStartup(observer, "shell-executable-lookup-requested");
        const exists = await runtime.filesystem.lookup(executable);
        markStartup(observer, "shell-executable-lookup-resolved");
        if (!exists) {
          markStartup(observer, "shell-executable-write-requested");
          await runtime.filesystem.writeFile(executable, new Uint8Array());
          markStartup(observer, "shell-executable-write-resolved");
        }
        markStartup(observer, "shell-filesystem-drain-requested");
        await runtime.filesystem.drain();
        markStartup(observer, "shell-filesystem-drain-resolved");
      })();
      initialized = attempt;
      void attempt.catch(() => {
        if (initialized === attempt) initialized = undefined;
      });
      return attempt;
    },
  };
}

export async function startShell(
  options: ShellOptions,
  terminal: SharedBridge,
): Promise<RuntimeProcess> {
  const runtime = options.runtime;
  options.signal?.throwIfAborted();
  const registration = registerShell(runtime, options);
  const filesystem = runtime.filesystem.fork();
  const { port: _port, ...identity } = filesystem;
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
    capacity: processDirectoryCapacity,
  });
  const state = workerProcessState(transport);
  const admission = createTerminalAdmission();
  attachTerminal(admission, terminal.buffer);
  transport.data = {
    filesystem: identity,
    shellTerminal: terminal.buffer,
    terminalAdmission: admission,
  };
  const memory = new SharedArrayBuffer(8);
  const observation = observeRoot(runtime, transport, memory);
  const writeTerminal = (fd: 1 | 2, bytes: Uint8Array): number => {
    const accepted = terminal.tryWrite([bytes]);
    const retained = accepted < 0 ? 0 : Math.min(accepted, bytes.length);
    const dropped = bytes.length - retained;
    if (dropped) {
      observation.dropped(dropped);
      console.error(`bash-web terminal output dropped ${dropped} bytes on fd ${fd}`);
    }
    return accepted;
  };
  let service: ProcessService | undefined;
  let worker: Worker | undefined;
  let acknowledged = false;
  let finished = false;
  let accepted = false;
  let retired = false;
  let physicallyStopped: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let unobserveExit = () => {};
  let release = () => {};
  let resolveDone!: (result: RuntimeExit) => void;
  const done = new Promise<RuntimeExit>((resolve) => {
    resolveDone = resolve;
  });
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  void started.catch(() => {});
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => {});
  const abort = () => {
    rejectAbort(options.signal!.reason);
  };
  const pending = async <T>(task: () => Promise<T>): Promise<T> => {
    options.signal?.throwIfAborted();
    const value = await Promise.race([task(), aborted]);
    options.signal?.throwIfAborted();
    return value;
  };
  const killOwnedJobs = () => {
    const jobs = new Set(
      workerProcessSlots(transport)
        .map((slot) => workerProcessState(transport, slot))
        .filter((process) => !readOutcome(process.signals.outcome))
        .map((process) => process.job),
    );
    return Array.from(jobs, (job) => service!.killJob(job, 9));
  };
  const physicallyStop = () =>
    (physicallyStopped ??= (async () => {
      unobserveExit();
      await quiesceTerminal(admission);
      worker?.terminate();
      filesystem.port.close();
      observation.stopped();
      if (!accepted || retired) observation.retired();
      release();
    })());
  const clean = () => {
    if (runtime.disposed) return Promise.resolve(); // Runtime now owns the physical fence/stop.
    return (cleanup ??= (async () => {
      if (accepted) {
        const selected = readOutcome(state.signals.outcome);
        await service!.rootExit(state.pid, selected ? waitStatus(selected) : 1);
      } else if (acknowledged || !worker) runtime.filesystem.reap(identity);
      else await runtime.filesystem.quiesce(identity);
      await physicallyStop();
    })());
  };
  const finish = (result: RuntimeExit, ack = false, signal?: number) => {
    if (finished) return;
    finished = true;
    acknowledged = ack;
    const winner = claimOutcome(
      state.signals.outcome,
      signal === undefined
        ? { kind: "exited", code: result.code }
        : { kind: "signaled", code: signal },
    );
    const status = waitStatus(winner);
    if (Atomics.load(terminal.state, control.phase) !== 4) {
      Atomics.store(terminal.state, control.status, status);
      Atomics.store(terminal.state, control.phase, result.error ? 4 : 3);
    }
    if (result.error) rejectStarted(new Error(result.error));
    else resolveStarted();
    resolveDone({ ...result, code: status });
    if (ack && !runtime.disposed) runtime.filesystem.reap(identity);
    void clean().catch((error) => console.error("Shell root cleanup failed", error));
  };
  const revoke = () => {
    revokeTerminal(admission);
    rejectAbort(new Error("Runtime is disposed"));
    finish({ code: 137, error: "Runtime was disposed" }, false, 9);
  };
  try {
    options.signal?.addEventListener("abort", abort, { once: true });
    options.signal?.throwIfAborted();
    // Accepted synchronously, before fetch, FS initialization, or lazy process admission.
    release = runtime.retainConsumer({ filesystem: identity, revoke, stop: physicallyStop });
    markStartup(options.onStartupStage, "shell-registration-requested");
    await pending(() => registration.initialize(options.onStartupStage));
    markStartup(options.onStartupStage, "shell-registration-resolved");
    markStartup(options.onStartupStage, "shell-module-requested");
    const loaded = await pending(() => registration.module(options.onStartupStage));
    markStartup(options.onStartupStage, "shell-module-resolved");
    if (runtime.disposed) throw new Error("Runtime is disposed");
    markStartup(options.onStartupStage, "shell-processes-requested");
    service = await pending(() => runtime.processes());
    markStartup(options.onStartupStage, "shell-processes-resolved");
    markStartup(options.onStartupStage, "shell-root-adopt-requested");
    await service.adoptRuntimeRoot(transport, {
      filesystem: identity,
      acknowledged: () => acknowledged,
      output: (fd, bytes) => {
        writeTerminal(fd === 2 ? 2 : 1, bytes);
      },
      async quiesce() {
        await quiesceTerminal(admission);
      },
      stop: physicallyStop,
      wake: () => terminal.signal(),
      retired() {
        retired = true;
        observation.retired();
      },
    });
    markStartup(options.onStartupStage, "shell-root-adopt-resolved");
    accepted = true;
    // Admission may already own this transport when its promise settles. Join it before
    // observing cancellation so cleanup cannot race a late broker acceptance.
    options.signal?.throwIfAborted();
    markStartup(options.onStartupStage, "shell-supervisor-requested");
    const supervisor = await pending(() => service!.ready());
    markStartup(options.onStartupStage, "shell-supervisor-resolved");
    observeSupervisor(runtime, supervisor);
    if (runtime.disposed) throw new Error("Runtime is disposed");
    // Waffle already owns process completion. Observe its exit event instead of
    // running a second page timer for every idle shell root.
    unobserveExit = supervisor.onChildExit((event) => {
      if (event.pid !== state.pid) return;
      if (event.result.kind === "signaled")
        finish({ code: event.result.status }, false, event.result.code);
      else finish({ code: waitStatus(event.result) }, false);
    });
    const settled = readOutcome(state.signals.outcome);
    if (settled?.kind === "signaled") {
      finish({ code: settled.status }, false, settled.code);
      await clean();
      throw new Error("Shell stopped before worker startup");
    }
    worker = new Worker(registration.workerUrl, { type: "module" });
    worker.onmessage = ({ data: message }: MessageEvent<RuntimeWorkerMessage>) => {
      if (runtime.disposed) return;
      if (finished) {
        if (message.type === "runtime-proc") service!.rejectRuntimeMessage(message, state.pid);
        return;
      }
      const selected = readOutcome(state.signals.outcome);
      if (message.type === "runtime-proc") {
        if (selected?.kind === "signaled") service!.rejectRuntimeMessage(message, state.pid);
        else {
          observeProcessMessage(runtime, message);
          void service!
            .runtimeMessage(message, state.pid)
            .catch((error) => finish({ code: 1, error: String(error) }));
        }
      } else if (message.type === "exit") finish({ code: message.code }, true, message.signal);
      else if (message.type === "error")
        finish({ code: message.code, error: message.message }, true);
      else if (message.type === "cleanup-error")
        finish({ code: message.code, error: message.message }, false, message.signal);
      else if (message.type === "default-signal")
        finish({ code: 128 + message.signal }, false, message.signal);
      else if (selected?.kind === "signaled")
        finish({ code: selected.status }, false, selected.code);
      else if (message.type === "phase" && message.name === "instantiate") resolveStarted();
      else if (message.type === "stdout" || message.type === "stderr")
        writeTerminal(message.type === "stderr" ? 2 : 1, message.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ code: 1, error: `Shell worker failed: ${event.message}` });
    };
    worker.onmessageerror = () =>
      finish({ code: 1, error: "Shell worker message could not be decoded" });
    const cwd = options.cwd ?? "/home/guest";
    const request: ShellWorkerRequest = {
      module: loaded.module,
      args:
        options.script === undefined
          ? ["shell-engine", "-i"]
          : ["shell-engine", "-c", options.script],
      env: {
        HOME: "/home/guest",
        USER: "guest",
        PATH: "/bin",
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        ...options.env,
        PWD: cwd,
      },
      filesystem,
      runtimeProcess: transport,
      terminal: terminal.buffer,
      terminalAdmission: admission,
      memoryUsage: memory,
    };
    worker.postMessage(request, [filesystem.port]);
    markStartup(options.onStartupStage, "shell-worker-start-requested");
    await pending(() => started);
    markStartup(options.onStartupStage, "shell-worker-start-resolved");
    return {
      pid: state.pid,
      wasmBytes: loaded.size,
      done,
      signal(signal) {
        if (!finished && !runtime.disposed)
          void service!
            .kill(state.pid, signal)
            .catch((error) => finish({ code: 1, error: String(error) }));
      },
      async dispose() {
        if (!runtime.disposed) {
          // A facade owns only its descendants. The shared runtime and other shell
          // roots keep running. Include synchronous reservations not admitted yet.
          const kills = killOwnedJobs();
          finish({ code: 137 }, false, 9);
          await Promise.all(kills);
          await clean();
        }
        await waitForShellWorkers(runtime, transport);
      },
    };
  } catch (error) {
    // No worker received a constructor-failed fork, so reap it without an unneeded
    // worker acknowledgement. A posted worker failure still goes through rootExit.
    if (!worker && !runtime.disposed) acknowledged = true;
    const cancelled = options.signal?.aborted;
    const kills = cancelled && accepted && !runtime.disposed ? killOwnedJobs() : [];
    finish(
      {
        code: cancelled ? 137 : 126,
        error: error instanceof Error ? error.message : String(error),
      },
      !worker,
      cancelled ? 9 : undefined,
    );
    await Promise.all(kills);
    if (!runtime.disposed) await clean();
    if (cancelled) await waitForShellWorkers(runtime, transport);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
