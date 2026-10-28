import type { GuestLauncher } from "waffle";

/** Caller composition for Waffle's generic preview1 worker, not a shell adapter. */
export function genericProgramLauncher(workerUrl: string | URL): GuestLauncher {
  const url = new URL(workerUrl, globalThis.document?.baseURI ?? import.meta.url).href;
  return (context, service) =>
    service.launchWorker(context, {
      workerUrl: url,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    });
}
