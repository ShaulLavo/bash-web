import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/mv`, its own WASM program, on the caller's Runtime. */
export function installMv(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/mv.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "mv", path: "/bin/mv", defaultUrl, execution: "wasi" },
    options,
  );
}
