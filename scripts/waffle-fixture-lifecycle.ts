import assert from "node:assert/strict";
import type { TestContext } from "node:test";

export interface WaffleFixtureRuntime {
  dispose(): Promise<void>;
}

export interface WaffleFixtureDependencies<Runtime extends WaffleFixtureRuntime> {
  installNodeWorkers(): void;
  createRuntime(): Runtime;
  stopNodeWorkers(): Promise<void>;
  liveNodeWorkers(): number;
}

async function attemptAsync(
  action: () => Promise<void> | void,
  remember: (error: unknown) => void,
) {
  try {
    await action();
  } catch (error) {
    remember(error);
  }
}

function attempt(action: () => void, remember: (error: unknown) => void) {
  try {
    action();
  } catch (error) {
    remember(error);
  }
}

async function cleanupWaffleFixture<Runtime extends WaffleFixtureRuntime>(
  runtime: Runtime | undefined,
  stop: () => void,
  dependencies: Pick<WaffleFixtureDependencies<Runtime>, "stopNodeWorkers" | "liveNodeWorkers">,
) {
  let firstError: unknown;
  const remember = (error: unknown) => {
    firstError ??= error;
  };
  attempt(stop, remember);
  await attemptAsync(() => runtime?.dispose(), remember);
  await attemptAsync(dependencies.stopNodeWorkers, remember);
  attempt(() => assert.equal(dependencies.liveNodeWorkers(), 0), remember);
  if (firstError) throw firstError;
}

export async function createWaffleFixture<Runtime extends WaffleFixtureRuntime>(
  context: TestContext,
  dependencies: WaffleFixtureDependencies<Runtime>,
) {
  let runtime: Runtime | undefined;
  let stop = () => {};
  context.after(() => cleanupWaffleFixture(runtime, stop, dependencies));
  dependencies.installNodeWorkers();
  runtime = dependencies.createRuntime();
  return {
    runtime,
    setStop(terminate: () => void) {
      stop = terminate;
    },
  };
}
