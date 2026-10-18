import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type UtilityOptions } from "./install";
export type { UtilityInstallation, UtilityModule, UtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/mkdir`, its own WASM program, on the caller's Runtime. */
export function installMkdir(runtime: Runtime, options?: UtilityOptions): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/mkdir.wasm", import.meta.url);
  return installUtility(runtime, { name: "mkdir", path: "/bin/mkdir", defaultUrl }, options);
}
