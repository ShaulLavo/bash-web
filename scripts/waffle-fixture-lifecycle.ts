import assert from "node:assert/strict";

interface WaffleFixtureContext {
  after(callback: () => Promise<void>): void;
}

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
  const failures: unknown[] = [];
  const remember = (error: unknown) => {
    failures.push(error);
  };
  attempt(stop, remember);
  await attemptAsync(() => runtime?.dispose(), remember);
  await attemptAsync(dependencies.stopNodeWorkers, remember);
  attempt(() => assert.equal(dependencies.liveNodeWorkers(), 0), remember);
  if (failures.length > 0) throw failures[0];
}

export async function createWaffleFixture<Runtime extends WaffleFixtureRuntime>(
  context: WaffleFixtureContext,
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
