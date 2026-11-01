export interface WorkerIdentity {
  id: number;
  name: string;
  url: string;
  createdAt: number;
  terminationRequestedAt: number | null;
  launch: { pid: number | null; args: string[]; order: number } | null;
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
  persistentWorkerNames: string[];
  idlePools: { url: string; capacity: number }[];
}

export type PipelineWorkerRetirementCheck =
  | { status: "retired" }
  | { status: "pending"; retirementOnly: boolean; observation: PipelineWorkerObservation }
  | { status: "failed"; reason: string; observation: PipelineWorkerObservation };

export interface WaitForPipelineWorkerRetirementOptions {
  timeoutMs?: number;
  retirementGraceMs?: number;
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
  const listedWorkerNames = observation.listedWorkers.map((worker) => worker.name);
  const listed = new Set(listedWorkerNames);
  const rows = observation.diagnostics.workers.filter((worker) => listed.has(worker.name));
  const processUrls = new Set(
    rows.filter((worker) => worker.launch !== null).map((worker) => worker.url),
  );
  const idle = rows.filter((worker) => worker.launch === null && processUrls.has(worker.url));
  const idleNames = new Set(idle.map((worker) => worker.name));
  const capacities = new Map<string, number>();
  for (const worker of idle) capacities.set(worker.url, (capacities.get(worker.url) ?? 0) + 1);
  return {
    listedWorkerNames,
    diagnosticWorkerIds: observation.diagnostics.workers.map((worker) => worker.id),
    persistentWorkerNames: listedWorkerNames.filter((name) => !idleNames.has(name)),
    idlePools: Array.from(capacities, ([url, capacity]) => ({ url, capacity })),
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

  return checkWorkerRoles(baseline, observation);
}

function checkWorkerRoles(
  baseline: PipelineWorkerRetirementBaseline,
  observation: PipelineWorkerObservation,
): PipelineWorkerRetirementCheck {
  const listed = new Set(observation.listedWorkers.map((worker) => worker.name));
  const rows = observation.diagnostics.workers.filter((worker) => listed.has(worker.name));
  const persistent = new Set(baseline.persistentWorkerNames);
  const poolCapacity = baseline.idlePools.reduce((total, pool) => total + pool.capacity, 0);
  const poolUrl = lastProcessWorkerUrl(observation.diagnostics.workers);
  const active = rows.filter((worker) => worker.terminationRequestedAt === null);
  const unexpected = active.filter(
    (worker) => !persistent.has(worker.name) && (worker.launch !== null || worker.url !== poolUrl),
  );
  if (unexpected.length > 0) {
    return {
      status: "failed",
      reason: `unexpected live worker(s) had no termination request: ${formatWorkers(unexpected)}`,
      observation,
    };
  }
  const idleCount = active.filter((worker) => !persistent.has(worker.name)).length;
  if (idleCount > poolCapacity) {
    return { status: "failed", reason: "unrequested idle worker pool grew", observation };
  }
  const activeNames = new Set(active.map((worker) => worker.name));
  const baselineRecovered =
    baseline.persistentWorkerNames.every((name) => activeNames.has(name)) &&
    idleCount === poolCapacity;
  const retiring = rows.some((worker) => worker.terminationRequestedAt !== null);
  if (baselineRecovered && !retiring) return { status: "retired" };
  return { status: "pending", retirementOnly: baselineRecovered && retiring, observation };
}

function lastProcessWorkerUrl(workers: readonly WorkerIdentity[]): string | undefined {
  let order = 0;
  let url: string | undefined;
  for (const worker of workers) {
    if (worker.launch === null || worker.launch.order <= order) continue;
    order = worker.launch.order;
    url = worker.url;
  }
  return url;
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
  const retirementGraceMs = options.retirementGraceMs ?? 3_000;
  let retirementDeadline: number | undefined;
  let observation = await observe();

  while (true) {
    const check = checkPipelineWorkerRetirement(baseline, observation);
    if (check.status === "retired") return;
    if (check.status === "failed") {
      throw new Error(`pipeline worker retirement failed: ${check.reason}`);
    }

    const at = now();
    if (at >= deadline && check.retirementOnly && retirementDeadline === undefined) {
      retirementDeadline = deadline + retirementGraceMs;
    }
    const remainingMs = (check.retirementOnly ? (retirementDeadline ?? deadline) : deadline) - at;
    if (remainingMs <= 0) {
      throw new Error(
        `pipeline worker retirement timed out with ${check.observation.listedWorkers.length} listed worker(s) after ${at - (deadline - timeoutMs)} ms: ${formatWorkers(check.observation.listedWorkers)}`,
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
  let nextLaunch = 0;
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
    return { pid: typeof pid === "number" ? pid : null, args, order: ++nextLaunch };
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
