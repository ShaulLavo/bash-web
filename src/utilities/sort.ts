import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/sort`, its own WASM program, on the caller's Runtime. */
export function installSort(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/sort.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "sort", path: "/bin/sort", defaultUrl, execution: "wasi" },
    options,
  );
}
