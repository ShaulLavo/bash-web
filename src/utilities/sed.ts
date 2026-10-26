import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/sed`, its own WASM program, on the caller's Runtime. */
export function installSed(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/sed.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "sed", path: "/bin/sed", defaultUrl, execution: "wasi" },
    options,
  );
}
