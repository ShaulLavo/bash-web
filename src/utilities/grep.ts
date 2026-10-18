import type { Runtime } from "waffle";
import { installUtility, type UtilityOptions, type UtilityInstallation } from "./install";
export type { UtilityOptions, UtilityInstallation } from "./install";
export { UtilityConflictError } from "./install";

export function installGrep(runtime: Runtime, options: UtilityOptions = {}): Promise<UtilityInstallation> {
  return installUtility(runtime, "grep", new URL("../../dist/grep.wasm", import.meta.url), options);
}
