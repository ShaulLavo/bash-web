import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/cut`, its own WASM program, on the caller's Runtime. */
export function installCut(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/cut.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "cut", path: "/bin/cut", defaultUrl, execution: "wasi" },
    options,
  );
}
