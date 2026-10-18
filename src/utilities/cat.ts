import type { Runtime } from "waffle";
import { installUtility, type UtilityOptions, type UtilityInstallation } from "./install";
export type { UtilityOptions, UtilityInstallation } from "./install";
export { UtilityConflictError } from "./install";

export function installCat(runtime: Runtime, options: UtilityOptions = {}): Promise<UtilityInstallation> {
  return installUtility(runtime, "cat", new URL("../../dist/cat.wasm", import.meta.url), options);
}
