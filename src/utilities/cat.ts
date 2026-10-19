import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type UtilityOptions } from "./install";
export type { UtilityInstallation, UtilityModule, UtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/cat`, its own WASM program, on the caller's Runtime. */
export function installCat(
  runtime: Runtime,
  options?: UtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/cat.wasm", import.meta.url);
  return installUtility(runtime, { name: "cat", path: "/bin/cat", defaultUrl }, options);
}
