import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/touch`, its own WASM program, on the caller's Runtime. */
export function installTouch(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/touch.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "touch", path: "/bin/touch", defaultUrl, execution: "wasi" },
    options,
  );
}
