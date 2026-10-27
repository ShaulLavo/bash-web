import type { Runtime } from "waffle";
import {
  installUtility,
  type UtilityInstallation,
  type WasiUtilityOptions,
} from "../runtime/shell-install";
import { createPythonPayload, PYTHON_ARGV0, type PythonPayloadSource } from "./python-payload";
export type {
  PythonPayloadFile,
  PythonPayloadManifest,
  PythonPayloadSource,
} from "./python-payload";
export type {
  UtilityInstallation,
  UtilitySource,
  WasiUtilityOptions,
} from "../runtime/shell-install";
export { UtilityConflictError } from "../runtime/shell-install";

export type PythonOptions = WasiUtilityOptions &
  (
    | { readonly payloadUrl?: string | URL; readonly payload?: never }
    | { readonly payload: PythonPayloadSource; readonly payloadUrl?: never }
  );

async function interpreter(options: WasiUtilityOptions): Promise<Uint8Array> {
  if (options.source instanceof Uint8Array) return options.source;
  if (options.source) return options.source();
  const url = new URL(
    options.wasmUrl ?? new URL("../../dist/python.wasm", import.meta.url),
    globalThis.document?.baseURI ?? import.meta.url,
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Python interpreter fetch failed: ${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Install lazy CPython WASI and its standard library on the caller's Runtime. */
export async function installPython(
  runtime: Runtime,
  options: PythonOptions = {},
): Promise<UtilityInstallation> {
  const payload = createPythonPayload(runtime, options);
  const base = await installUtility(
    runtime,
    {
      name: "python",
      path: "/bin/python",
      defaultUrl: new URL("../../dist/python.wasm", import.meta.url),
      execution: "wasi",
      argv0: PYTHON_ARGV0,
    },
    { workerUrl: options.workerUrl, source: () => payload.load(() => interpreter(options)) },
  );
  let disposal: Promise<void> | undefined;
  return {
    executable: base.executable,
    dispose() {
      if (disposal) return disposal;
      // Both calls close admission synchronously, before either cleanup awaits I/O.
      const pending = payload.dispose();
      disposal = joinDisposal(base.dispose(), pending);
      return disposal;
    },
  };
}

async function joinDisposal(...pending: Promise<void>[]): Promise<void> {
  const settled = await Promise.allSettled(pending);
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Python disposal failed");
}
