import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  capturePipelineFailure,
  checkPipelineWorkerRetirement,
  createPipelineWorkerRetirementBaseline,
  installPipelineWorkerDiagnostics,
  type PipelineWorkerObservation,
  waitForPipelineWorkerRetirement,
} from "./helpers/pipeline-failure-diagnostics.ts";

test("successful pipeline emits no diagnostics", async () => {
  let captures = 0;
  await capturePipelineFailure(
    async () => {},
    async () => {
      captures++;
    },
  );
  assert.equal(captures, 0);
});

test("pipeline failure captures once and rethrows the identical failure", async () => {
  const original = new Error("worker count mismatch");
  let captures = 0;
  await assert.rejects(
    capturePipelineFailure(
      async () => {
        throw original;
      },
      async () => {
        captures++;
      },
    ),
    (error) => error === original,
  );
  assert.equal(captures, 1);
});

test("diagnostic failure cannot replace the pipeline failure", async () => {
  const original = new Error("worker count mismatch");
  await assert.rejects(
    capturePipelineFailure(
      async () => {
        throw original;
      },
      async () => {
        throw new Error("page closed");
      },
    ),
    (error) => error === original,
  );
});

test("synchronous diagnostic failure also preserves the pipeline failure", async () => {
  const original = new Error("worker count mismatch");
  await assert.rejects(
    capturePipelineFailure(
      async () => {
        throw original;
      },
      () => {
        throw new Error("attachment failed synchronously");
      },
    ),
    (error) => error === original,
  );
});

class NativeWorker {
  readonly messages: { message: unknown; options: unknown }[] = [];
  terminations = 0;
  readonly url: string | URL;
  readonly options?: WorkerOptions;
  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
  }
  postMessage(message: unknown, options?: unknown) {
    this.messages.push({ message, options });
  }
  terminate() {
    this.terminations++;
  }
}

function observation() {
  const scope: {
    Worker: typeof NativeWorker;
    pipelineWorkerDiagnostics?: Window["pipelineWorkerDiagnostics"];
  } = { Worker: NativeWorker };
  runInNewContext(`(${installPipelineWorkerDiagnostics.toString()})()`, { window: scope });
  assert.ok(scope.pipelineWorkerDiagnostics);
  return { Worker: scope.Worker, diagnostic: scope.pipelineWorkerDiagnostics };
}

test("passive worker observation forwards original requests and termination", () => {
  const scope = observation();
  const options = { type: "module" } satisfies WorkerOptions;
  const worker = new scope.Worker("worker.js", options);
  const request = { args: ["test-guest", "yes", "tick"], runtimeProcess: { pid: 17 } };
  const transfer: Transferable[] = [];
  worker.postMessage(request, transfer);
  worker.postMessage({ control: true }, { transfer });
  worker.terminate();
  assert.equal(worker.options, options);
  assert.match(String(worker.url), /#bash-web-pipeline-worker=bash-web-pipeline-worker-1$/);
  assert.equal(worker.messages[0].message, request);
  assert.equal(worker.messages[0].options, transfer);
  assert.equal(worker.terminations, 1);
  const diagnostic = scope.diagnostic;
  assert.equal(diagnostic.workers.length, 1);
  assert.equal(diagnostic.workers[0].id, 1);
  assert.equal(diagnostic.workers[0].name, "bash-web-pipeline-worker-1");
  assert.ok(diagnostic.workers[0].launch);
  assert.equal(diagnostic.workers[0].launch.pid, 17);
  assert.equal(diagnostic.workers[0].launch.args.join(" "), "test-guest yes tick");
  assert.equal(typeof diagnostic.workers[0].terminationRequestedAt, "number");
  assert.equal(request.args.length, 3);
});

test("worker observation bounds identities and launch arguments without retaining requests", () => {
  const scope = observation();
  const worker = new scope.Worker("x".repeat(1000));
  const request = {
    args: Array.from({ length: 20 }, () => "x".repeat(1000)),
    runtimeProcess: { pid: 1 },
  };
  worker.postMessage(request);
  request.args[0] = "changed";
  for (let index = 0; index < 100; index++) new scope.Worker("worker.js").terminate();
  const diagnostic = scope.diagnostic;
  assert.equal(diagnostic.workers.length, 64);
  assert.equal(diagnostic.omittedWorkers, 37);
  assert.equal(diagnostic.workers[0].url.length, 512);
  assert.ok(diagnostic.workers[0].launch);
  assert.equal(diagnostic.workers[0].launch.args.length, 8);
  assert.equal(diagnostic.workers[0].launch.args[0].length, 128);
});

function makeWorker(
  id: number,
  name: string,
  terminationRequestedAt: number | null,
): PipelineWorkerObservation["diagnostics"]["workers"][number] {
  return {
    id,
    name,
    url: `${name}.js`,
    createdAt: id,
    terminationRequestedAt,
    launch: null,
  };
}

function pipelineObservation(
  listedNames: string[],
  diagnosticWorkers: PipelineWorkerObservation["diagnostics"]["workers"],
  omittedWorkers = 0,
): PipelineWorkerObservation {
  return {
    listedWorkers: listedNames.map((name) => ({ name, url: `${name}.js` })),
    diagnostics: { workers: diagnosticWorkers, omittedWorkers },
  };
}

function fakeRetirementWait(
  baseline: ReturnType<typeof createPipelineWorkerRetirementBaseline>,
  snapshots: PipelineWorkerObservation[],
  timeoutMs = 5_000,
  retirementGraceMs = 0,
) {
  let now = 0;
  let index = 0;
  const promise = waitForPipelineWorkerRetirement(
    async () => {
      const snapshot = snapshots[index] ?? snapshots[snapshots.length - 1];
      index++;
      return snapshot;
    },
    baseline,
    {
      timeoutMs,
      retirementGraceMs,
      pollIntervalMs: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    },
  );
  return { promise, now: () => now };
}

test("requested workers may retire while the baseline count recovers", async () => {
  const baseline = createPipelineWorkerRetirementBaseline(
    pipelineObservation(
      ["baseline-fs", "baseline-shell"],
      [makeWorker(1, "baseline-fs", null), makeWorker(2, "baseline-shell", null)],
    ),
  );
  const snapshots = [
    pipelineObservation(
      ["baseline-fs", "pipeline-child"],
      [
        makeWorker(1, "baseline-fs", null),
        makeWorker(2, "baseline-shell", null),
        makeWorker(3, "pipeline-child", 10),
      ],
    ),
    pipelineObservation(
      ["baseline-fs", "baseline-shell"],
      [
        makeWorker(1, "baseline-fs", null),
        makeWorker(2, "baseline-shell", null),
        makeWorker(3, "pipeline-child", 10),
      ],
    ),
  ];
  const wait = fakeRetirementWait(baseline, snapshots);
  await wait.promise;
  assert.equal(wait.now(), 100);
});

test("a requested worker that never retires fails at the deadline", async () => {
  const baseline = createPipelineWorkerRetirementBaseline(
    pipelineObservation(["baseline-fs"], [makeWorker(1, "baseline-fs", null)]),
  );
  const pending = pipelineObservation(
    ["baseline-fs", "pipeline-child"],
    [makeWorker(1, "baseline-fs", null), makeWorker(2, "pipeline-child", 10)],
  );
  const wait = fakeRetirementWait(baseline, [pending], 500);
  await assert.rejects(wait.promise, /after 500 ms/);
  assert.equal(wait.now(), 500);
});

test("an extra unrequested worker fails with its physical identity", () => {
  const baseline = createPipelineWorkerRetirementBaseline(
    pipelineObservation(["baseline-fs"], [makeWorker(1, "baseline-fs", null)]),
  );
  const current = pipelineObservation(
    ["baseline-fs", "unexpected-child"],
    [makeWorker(1, "baseline-fs", null), makeWorker(2, "unexpected-child", null)],
  );
  const result = checkPipelineWorkerRetirement(baseline, current);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.match(result.reason, /unexpected-child/);
    assert.equal(result.observation, current);
  }
});

test("identity and coverage failures fail closed", () => {
  const baseline = createPipelineWorkerRetirementBaseline(
    pipelineObservation(["baseline-fs"], [makeWorker(1, "baseline-fs", null)]),
  );
  const unknown = checkPipelineWorkerRetirement(
    baseline,
    pipelineObservation(["baseline-fs", "unknown-child"], [makeWorker(1, "baseline-fs", null)]),
  );
  assert.equal(unknown.status, "failed");
  if (unknown.status === "failed") {
    assert.match(unknown.reason, /not covered/);
  }
  const omitted = checkPipelineWorkerRetirement(
    baseline,
    pipelineObservation(["baseline-fs"], [makeWorker(1, "baseline-fs", null)], 1),
  );
  assert.equal(omitted.status, "failed");
  if (omitted.status === "failed") {
    assert.match(omitted.reason, /omitted 1 row/);
  }
});

function rotatingPool() {
  const fs = makeWorker(1, "filesystem", null);
  const shell = {
    ...makeWorker(2, "shell", null),
    url: "shell-worker.js",
    launch: { pid: 1, args: ["shell-engine", "-i"], order: 1 },
  };
  const idle = (id: number, name: string, terminationRequestedAt: number | null) => ({
    ...makeWorker(id, name, terminationRequestedAt),
    url: "shell-worker.js",
  });
  const initial = pipelineObservation(
    ["filesystem", "shell", "idle-a", "idle-b"],
    [fs, shell, idle(3, "idle-a", null), idle(4, "idle-b", null)],
  );
  const current = pipelineObservation(
    ["filesystem", "shell", "replacement-a", "replacement-b"],
    [
      fs,
      shell,
      idle(3, "idle-a", 10),
      idle(4, "idle-b", 10),
      idle(12, "replacement-a", null),
      idle(13, "replacement-b", null),
    ],
  );
  return { baseline: createPipelineWorkerRetirementBaseline(initial), current, idle };
}

test("single-use pool workers may be replaced without growing the baseline pool", () => {
  const { baseline, current } = rotatingPool();
  assert.equal(checkPipelineWorkerRetirement(baseline, current).status, "retired");
});

test("replacement pool growth and an unrequested leased child both fail", () => {
  const { baseline, current, idle } = rotatingPool();
  const extra = idle(14, "extra", null);
  const listed = current.listedWorkers.concat([{ name: extra.name, url: extra.url }]);
  const overflow = checkPipelineWorkerRetirement(baseline, {
    listedWorkers: listed,
    diagnostics: { workers: current.diagnostics.workers.concat([extra]), omittedWorkers: 0 },
  });
  assert.equal(overflow.status, "failed");
  const child = { ...extra, launch: { pid: 7, args: ["test-guest", "cat"], order: 2 } };
  const leaked = checkPipelineWorkerRetirement(baseline, {
    listedWorkers: listed,
    diagnostics: { workers: current.diagnostics.workers.concat([child]), omittedWorkers: 0 },
  });
  assert.equal(leaked.status, "failed");
});

test("only terminate-requested leftovers receive an additional bounded grace", async () => {
  const { baseline, current, idle } = rotatingPool();
  const child = idle(14, "stopping-child", 10);
  const pending = {
    listedWorkers: current.listedWorkers.concat([{ name: child.name, url: child.url }]),
    diagnostics: { workers: current.diagnostics.workers.concat([child]), omittedWorkers: 0 },
  };
  const delayed = Array.from({ length: 57 }, () => pending).concat([current]);
  const wait = fakeRetirementWait(baseline, delayed, 5_000, 3_000);
  await wait.promise;
  assert.equal(wait.now(), 5_700);
  const stuck = fakeRetirementWait(baseline, [pending], 5_000, 3_000);
  await assert.rejects(stuck.promise, /after 8000 ms/);
  assert.equal(stuck.now(), 8_000);
});

test("grace never hides an unrequested child or missing persistent worker", async () => {
  const { baseline, current, idle } = rotatingPool();
  const child = { ...idle(14, "unrequested", null), launch: { pid: 7, args: ["cat"], order: 2 } };
  const extra = {
    listedWorkers: current.listedWorkers.concat([{ name: child.name, url: child.url }]),
    diagnostics: { workers: current.diagnostics.workers.concat([child]), omittedWorkers: 0 },
  };
  const wait = fakeRetirementWait(baseline, [extra], 5_000, 3_000);
  await assert.rejects(wait.promise, /no termination request/);
  assert.equal(wait.now(), 0);
  const missing = {
    ...current,
    listedWorkers: current.listedWorkers.filter((w) => w.name !== "shell"),
  };
  const absent = fakeRetirementWait(baseline, [missing], 5_000, 3_000);
  await assert.rejects(absent.promise, /after 5000 ms/);
  assert.equal(absent.now(), 5_000);
});

test("the idle pool follows the last process launch across worker scripts", () => {
  const { baseline, current } = rotatingPool();
  const preview = {
    ...makeWorker(14, "grep", 10),
    url: "preview1-worker.js",
    launch: { pid: 2, args: ["grep", "unmatched"], order: 2 },
  };
  const rows = current.diagnostics.workers
    .map((worker) =>
      worker.name.startsWith("replacement-") ? { ...worker, url: preview.url } : worker,
    )
    .concat([preview]);
  const healthy = { ...current, diagnostics: { workers: rows, omittedWorkers: 0 } };
  assert.equal(checkPipelineWorkerRetirement(baseline, healthy).status, "retired");
});

test("idle allowance follows launch order rather than construction order", () => {
  const { baseline, current } = rotatingPool();
  const latest = {
    ...makeWorker(3, "idle-a", 10),
    url: "shell-worker.js",
    launch: { pid: 7, args: ["test-guest", "cat"], order: 5 },
  };
  const laterConstructed = {
    ...makeWorker(15, "later-constructed", 10),
    url: "preview1-worker.js",
    launch: { pid: 6, args: ["grep", "unmatched"], order: 4 },
  };
  const replacementRows = current.diagnostics.workers
    .filter((worker) => worker.id !== 3)
    .map((worker) =>
      worker.name.startsWith("replacement-") ? { ...worker, url: latest.url } : worker,
    );
  const healthy = {
    ...current,
    diagnostics: { workers: replacementRows.concat([latest, laterConstructed]), omittedWorkers: 0 },
  };
  assert.equal(checkPipelineWorkerRetirement(baseline, healthy).status, "retired");
  const foreign = {
    ...healthy,
    diagnostics: {
      workers: healthy.diagnostics.workers.map((worker) =>
        worker.name.startsWith("replacement-") ? { ...worker, url: "unlaunched.js" } : worker,
      ),
      omittedWorkers: 0,
    },
  };
  assert.equal(checkPipelineWorkerRetirement(baseline, foreign).status, "failed");
});
