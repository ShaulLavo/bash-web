import { expect as playwrightExpect } from "@playwright/test";

function softToBe(failures: Error[], actual: unknown, message?: string) {
  return {
    toBe(expected: unknown) {
      try {
        playwrightExpect(actual, message).toBe(expected);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push(error);
      }
    },
  };
}

export function createPythonExpectContext(beforePoll?: () => Promise<void>) {
  function poll<T>(
    sample: () => T | Promise<T>,
    options?: Parameters<typeof playwrightExpect.poll>[1],
  ) {
    return playwrightExpect.poll(async () => {
      await beforePoll?.();
      return sample();
    }, options);
  }
  const failures: Error[] = [];
  const expect = Object.assign(
    <T>(actual: T, message?: string) => playwrightExpect(actual, message),
    {
      poll: beforePoll ? poll : playwrightExpect.poll,
      soft: (actual: unknown, message?: string) => softToBe(failures, actual, message),
    },
  );
  return {
    expect,
    finish() {
      if (failures.length === 0) return;
      throw new AggregateError(failures, `${failures.length} Python soft assertions failed`);
    },
  };
}
