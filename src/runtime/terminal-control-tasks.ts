/** Controller-owned waits stop accepting work before aborting and joining their registrations. */
export function createTerminalTasks(failed: (error: unknown) => void) {
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();
  let accepting = true;
  const stop = () => {
    accepting = false;
    lifetime.abort();
  };
  return {
    signal: lifetime.signal,
    get accepting() {
      return accepting;
    },
    run(work: () => Promise<void>): Promise<void> | undefined {
      if (!accepting) return;
      const task = Promise.resolve()
        .then(() => (accepting ? work() : undefined))
        .catch((error: unknown) => {
          if (!lifetime.signal.aborted) failed(error);
        })
        .finally(() => pending.delete(task));
      pending.add(task);
      return task;
    },
    stop,
    async join() {
      stop();
      while (pending.size) await Promise.all(Array.from(pending));
    },
  };
}
