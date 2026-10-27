import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/tr`, its own WASM program, on the caller's Runtime. */
export function installTr(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/tr.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "tr", path: "/bin/tr", defaultUrl, execution: "wasi" },
    options,
  );
}
