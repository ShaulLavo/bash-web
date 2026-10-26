import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/env`, its own WASM program, on the caller's Runtime. */
export function installEnv(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/env.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "env", path: "/bin/env", defaultUrl, execution: "wasi" },
    options,
  );
}
