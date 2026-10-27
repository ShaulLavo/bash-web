import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/which`, its own WASM program, on the caller's Runtime. */
export function installWhich(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/which.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "which", path: "/bin/which", defaultUrl, execution: "wasi" },
    options,
  );
}
