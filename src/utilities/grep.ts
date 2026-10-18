import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type UtilityOptions } from "./install";
export type { UtilityInstallation, UtilityModule, UtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/grep`, its own WASM program, on the caller's Runtime. */
export function installGrep(runtime: Runtime, options?: UtilityOptions): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/grep.wasm", import.meta.url);
  return installUtility(runtime, { name: "grep", path: "/bin/grep", defaultUrl }, options);
}
