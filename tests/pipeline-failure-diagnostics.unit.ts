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
  await assert.rejects(wait.promise, /timed out after 500 ms/);
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
