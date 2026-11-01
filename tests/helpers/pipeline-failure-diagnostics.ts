export interface WorkerIdentity {
  id: number;
  name: string;
  url: string;
  createdAt: number;
  terminationRequestedAt: number | null;
  launch: { pid: number | null; args: string[] } | null;
}

interface PipelineWorkerDiagnostics {
  workers: WorkerIdentity[];
  omittedWorkers: number;
}

interface ListedPipelineWorker {
  name: string;
  url: string;
}

export interface PipelineWorkerObservation {
  listedWorkers: ListedPipelineWorker[];
  diagnostics: PipelineWorkerDiagnostics;
}

export interface PipelineWorkerRetirementBaseline {
  listedWorkerNames: string[];
  diagnosticWorkerIds: number[];
}

export type PipelineWorkerRetirementCheck =
  | { status: "retired" }
  | { status: "pending"; observation: PipelineWorkerObservation }
  | { status: "failed"; reason: string; observation: PipelineWorkerObservation };

export interface WaitForPipelineWorkerRetirementOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

declare global {
  interface Window {
    pipelineWorkerDiagnostics: PipelineWorkerDiagnostics;
  }
}

export function createPipelineWorkerRetirementBaseline(
  observation: PipelineWorkerObservation,
): PipelineWorkerRetirementBaseline {
  return {
    listedWorkerNames: observation.listedWorkers.map((worker) => worker.name),
    diagnosticWorkerIds: observation.diagnostics.workers.map((worker) => worker.id),
  };
}

export function checkPipelineWorkerRetirement(
  baseline: PipelineWorkerRetirementBaseline,
  observation: PipelineWorkerObservation,
): PipelineWorkerRetirementCheck {
  if (observation.diagnostics.omittedWorkers !== 0) {
    return {
      status: "failed",
      reason: `worker diagnostic coverage omitted ${observation.diagnostics.omittedWorkers} row(s)`,
      observation,
    };
  }

  const baselineNames = new Set(baseline.listedWorkerNames);
  const currentNames = observation.listedWorkers.map((worker) => worker.name);
  const diagnosticByName = new Map<string, WorkerIdentity>(
    observation.diagnostics.workers.map((worker): [string, WorkerIdentity] => [
      worker.name,
      worker,
    ]),
  );
  const diagnosticById = new Map<number, WorkerIdentity>(
    observation.diagnostics.workers.map((worker): [number, WorkerIdentity] => [worker.id, worker]),
  );
  const duplicateBaselineNames = findDuplicates(baseline.listedWorkerNames);
  if (duplicateBaselineNames.length > 0) {
    return {
      status: "failed",
      reason: `baseline physical worker identity was not unique: ${duplicateBaselineNames.join(", ")}`,
      observation,
    };
  }
  const duplicateDiagnosticNames = findDuplicates(
    observation.diagnostics.workers.map((worker) => worker.name),
  );
  if (duplicateDiagnosticNames.length > 0) {
    return {
      status: "failed",
      reason: `diagnostic worker identity was not unique: ${duplicateDiagnosticNames.join(", ")}`,
      observation,
    };
  }
  const duplicateDiagnosticIds = findDuplicates(
    observation.diagnostics.workers.map((worker) => worker.id),
  );
  if (duplicateDiagnosticIds.length > 0) {
    return {
      status: "failed",
      reason: `diagnostic worker IDs were not unique: ${duplicateDiagnosticIds.join(", ")}`,
      observation,
    };
  }
  const missingBaselineIds = baseline.diagnosticWorkerIds.filter((id) => !diagnosticById.has(id));
  if (missingBaselineIds.length > 0) {
    return {
      status: "failed",
      reason: `baseline diagnostic row(s) disappeared: ${missingBaselineIds.join(", ")}`,
      observation,
    };
  }
  const missingBaselineDiagnosticNames = baseline.listedWorkerNames.filter(
    (name) => !diagnosticByName.has(name),
  );
  if (missingBaselineDiagnosticNames.length > 0) {
    return {
      status: "failed",
      reason: `baseline worker(s) were not covered by the diagnostic ledger: ${missingBaselineDiagnosticNames.join(", ")}`,
      observation,
    };
  }
  const duplicateCurrentNames = findDuplicates(currentNames);
  if (duplicateCurrentNames.length > 0) {
    return {
      status: "failed",
      reason: `physical worker identity was not unique: ${duplicateCurrentNames.join(", ")}`,
      observation,
    };
  }

  const unknownCurrentNames = currentNames.filter((name) => !diagnosticByName.has(name));
  if (unknownCurrentNames.length > 0) {
    return {
      status: "failed",
      reason: `physical worker identity was not covered by the diagnostic ledger: ${unknownCurrentNames.join(", ")}`,
      observation,
    };
  }

  const extraWorkers = observation.listedWorkers.filter(
    (worker) => !baselineNames.has(worker.name),
  );
  const unrequestedExtraWorkers = extraWorkers.filter(
    (worker) => diagnosticByName.get(worker.name)?.terminationRequestedAt === null,
  );
  if (unrequestedExtraWorkers.length > 0) {
    return {
      status: "failed",
      reason: `unexpected live worker(s) had no termination request: ${formatWorkers(unrequestedExtraWorkers)}`,
      observation,
    };
  }

  if (extraWorkers.length === 0 && currentNames.length === baseline.listedWorkerNames.length) {
    return { status: "retired" };
  }
  return { status: "pending", observation };
}

export async function waitForPipelineWorkerRetirement(
  observe: () => Promise<PipelineWorkerObservation>,
  baseline: PipelineWorkerRetirementBaseline,
  options: WaitForPipelineWorkerRetirementOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const deadline = now() + timeoutMs;
  let observation = await observe();

  while (true) {
    const check = checkPipelineWorkerRetirement(baseline, observation);
    if (check.status === "retired") return;
    if (check.status === "failed") {
      throw new Error(`pipeline worker retirement failed: ${check.reason}`);
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `pipeline worker retirement timed out after ${timeoutMs} ms with ${check.observation.listedWorkers.length} listed worker(s): ${formatWorkers(check.observation.listedWorkers)}`,
      );
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
    observation = await observe();
  }
}

function findDuplicates<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return Array.from(duplicates);
}

function formatWorkers(workers: readonly ListedPipelineWorker[]): string {
  return workers.map((worker) => `${worker.name} (${worker.url})`).join(", ");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  function identity(id: number, name: string, url: string | URL): WorkerIdentity | undefined {
    if (diagnostics.workers.length === 64) {
      diagnostics.omittedWorkers++;
      return;
    }
    const row: WorkerIdentity = {
      id,
      name,
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
      const id = ++nextId;
      const name = `bash-web-pipeline-worker-${id}`;
      const source = String(url);
      const hash = `#bash-web-pipeline-worker=${encodeURIComponent(name)}`;
      const hashIndex = source.indexOf("#");
      const diagnosticUrl = `${hashIndex >= 0 ? source.slice(0, hashIndex) : source}${hash}`;
      super(diagnosticUrl, options);
      this.diagnostic = identity(id, name, url);
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
