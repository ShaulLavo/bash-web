import type { Runtime } from "waffle";
import { installUtility, type UtilityOptions, type UtilityInstallation } from "./install";
export type { UtilityOptions, UtilityInstallation } from "./install";
export { UtilityConflictError } from "./install";

export function installMkdir(runtime: Runtime, options: UtilityOptions = {}): Promise<UtilityInstallation> {
  return installUtility(runtime, "mkdir", new URL("../../dist/mkdir.wasm", import.meta.url), options);
}
