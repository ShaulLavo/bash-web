interface WorkerIdentity {
  id: number;
  url: string;
  createdAt: number;
  terminationRequestedAt: number | null;
  launch: { pid: number | null; args: string[] } | null;
}

declare global {
  interface Window {
    pipelineWorkerDiagnostics: { workers: WorkerIdentity[]; omittedWorkers: number };
  }
}

export async function capturePipelineFailure(
  run: () => Promise<void>,
  capture: () => Promise<void>,
) {
  try {
    await run();
  } catch (error) {
    // A closed page or attachment error must not replace the failed assertion.
    try {
      await capture();
    } catch {}
    throw error;
  }
}

export function installPipelineWorkerDiagnostics() {
  const diagnostics: Window["pipelineWorkerDiagnostics"] = { workers: [], omittedWorkers: 0 };
  window.pipelineWorkerDiagnostics = diagnostics;
  let nextId = 0;
  function identity(url: string | URL): WorkerIdentity | undefined {
    const id = ++nextId;
    if (diagnostics.workers.length === 64) {
      diagnostics.omittedWorkers++;
      return;
    }
    const row: WorkerIdentity = {
      id,
      url: String(url).slice(0, 512),
      createdAt: Date.now(),
      terminationRequestedAt: null,
      launch: null,
    };
    diagnostics.workers.push(row);
    return row;
  }
  function launch(message: unknown): WorkerIdentity["launch"] {
    if (!message || typeof message !== "object" || !("args" in message)) return null;
    if (!Array.isArray(message.args)) return null;
    const transport = "runtimeProcess" in message ? message.runtimeProcess : undefined;
    const pid =
      transport && typeof transport === "object" && "pid" in transport ? transport.pid : null;
    const args: string[] = [];
    for (let index = 0; index < Math.min(message.args.length, 8); index++) {
      const arg: unknown = message.args[index];
      args.push(typeof arg === "string" ? arg.slice(0, 128) : "[non-string]");
    }
    return { pid: typeof pid === "number" ? pid : null, args };
  }
  window.Worker = class extends window.Worker {
    private readonly diagnostic: WorkerIdentity | undefined;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.diagnostic = identity(url);
    }
    postMessage(message: unknown, transfer: Transferable[]): void;
    postMessage(message: unknown, options?: StructuredSerializeOptions): void;
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
      if (this.diagnostic && !this.diagnostic.launch) this.diagnostic.launch = launch(message);
      if (Array.isArray(options)) return super.postMessage(message, options);
      super.postMessage(message, options);
    }
    terminate(): void {
      if (this.diagnostic) this.diagnostic.terminationRequestedAt = Date.now();
      super.terminate();
    }
  };
}
