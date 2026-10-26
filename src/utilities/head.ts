import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/head`, its own WASM program, on the caller's Runtime. */
export function installHead(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/head.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "head", path: "/bin/head", defaultUrl, execution: "wasi" },
    options,
  );
}
