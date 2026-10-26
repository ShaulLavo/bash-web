import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/cp`, its own WASM program, on the caller's Runtime. */
export function installCp(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/cp.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "cp", path: "/bin/cp", defaultUrl, execution: "wasi" },
    options,
  );
}
