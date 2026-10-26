import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/wc`, its own WASM program, on the caller's Runtime. */
export function installWc(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/wc.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "wc", path: "/bin/wc", defaultUrl, execution: "wasi" },
    options,
  );
}
