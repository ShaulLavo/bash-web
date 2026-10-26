import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type UtilityOptions } from "./install";
export type { UtilityInstallation, UtilityModule, UtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/tail`, its own WASM program, on the caller's Runtime. */
export function installTail(
  runtime: Runtime,
  options?: UtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/tail.wasm", import.meta.url);
  return installUtility(runtime, { name: "tail", path: "/bin/tail", defaultUrl }, options);
}
