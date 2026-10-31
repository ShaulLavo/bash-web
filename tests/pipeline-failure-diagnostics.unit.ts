import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  capturePipelineFailure,
  installPipelineWorkerDiagnostics,
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
  assert.equal(worker.messages[0].message, request);
  assert.equal(worker.messages[0].options, transfer);
  assert.equal(worker.terminations, 1);
  const diagnostic = scope.diagnostic;
  assert.equal(diagnostic.workers.length, 1);
  assert.equal(diagnostic.workers[0].id, 1);
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
