import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Register the lazy, fixed-profile VT `/bin/clear` guest on the caller's Runtime. */
export function installClear(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/clear.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "clear", path: "/bin/clear", defaultUrl, execution: "wasi" },
    options,
  );
}
