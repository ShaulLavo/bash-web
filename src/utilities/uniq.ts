import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/uniq`, its own WASM program, on the caller's Runtime. */
export function installUniq(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/uniq.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "uniq", path: "/bin/uniq", defaultUrl, execution: "wasi" },
    options,
  );
}
