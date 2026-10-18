import type { Runtime } from "waffle";
import { installUtility, type UtilityOptions, type UtilityInstallation } from "./install";
export type { UtilityOptions, UtilityInstallation } from "./install";
export { UtilityConflictError } from "./install";

export function installSeq(runtime: Runtime, options: UtilityOptions = {}): Promise<UtilityInstallation> {
  return installUtility(runtime, "seq", new URL("../../dist/seq.wasm", import.meta.url), options);
}
